/**
 * Focused unit tests for the bootstrap response size cap.
 *
 * The cap is "5 MB compressed". The old check approximated it
 * as `uncompressed > 5MB × 4`, assuming ~4:1 gzip on JSON — but every
 * payload is incompressible ciphertext, so that allowance
 * silently raised the cap to ~20 MB. The fixed check enforces the cap on
 * the ACTUAL gzipped size of the response.
 *
 * These tests stub the three repositories so they run WITHOUT the DynamoDB
 * emulator (the size logic lives entirely in BootstrapService.bootstrap).
 */
import { randomBytes } from 'node:crypto';
import { PayloadTooLargeException } from '@nestjs/common';
import { BootstrapService } from '../sync/bootstrap.service.js';
import type { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import type { SnapshotsService, SnapshotAggregate } from '../sync/snapshots.service.js';
import type { WorkspaceMetaRow } from '../dynamo/types.js';

const FIVE_MB = 5 * 1024 * 1024;

function metaRow(): WorkspaceMetaRow {
  return {
    householdId: 'hh-1',
    latestSnapshotId: 'snap-1',
    latestSnapshotCursor: '0',
    latestVersion: 1,
    lastUpdatedAt: new Date().toISOString(),
    mutationLogCursorBase: '0',
  };
}

/**
 * Build a snapshot whose aggregate payloads carry `payloadFactory()`-shaped
 * bytes, sized so the JSON-serialized response totals at least `targetBytes`
 * uncompressed. High-entropy bytes barely shrink under gzip (so a >5 MB
 * uncompressed total stays >5 MB gzipped → 413); a compressible string of
 * the same uncompressed volume gzips far under 5 MB → passes.
 */
function buildSnapshot(
  targetBytes: number,
  payloadFactory: () => string,
): SnapshotAggregate[] {
  const aggregates: SnapshotAggregate[] = [];
  let total = 0;
  let i = 0;
  while (total < targetBytes) {
    const blob = payloadFactory();
    aggregates.push({
      id: `agg-${i}`,
      householdId: 'hh-1',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-1',
      aggregateType: 'account',
      payload: { blob },
    });
    total += blob.length;
    i += 1;
  }
  return aggregates;
}

function makeService(snapshot: SnapshotAggregate[]): BootstrapService {
  const meta = {
    createIfMissing: async () => metaRow(),
  } as unknown as WorkspaceMetaRepository;
  const log = {
    // No post-snapshot mutations — all the size lives in the snapshot half.
    pageSince: async () => ({ items: [], lastSequenceId: null, hasMore: false }),
  } as unknown as MutationLogRepository;
  const snapshots = {
    fetch: async () => ({ aggregates: snapshot, cutoff: '0' }),
  } as unknown as SnapshotsService;
  return new BootstrapService(meta, log, snapshots);
}

describe('BootstrapService — compressed size cap', () => {
  it('413s when the high-entropy (incompressible) response exceeds 5 MB gzipped', async () => {
    // ~9 MB of random base64 gzips to ~6.8 MB (base64 only compresses ~25%),
    // staying above the 5 MB compressed cap. The old ×4 allowance (which
    // only tripped above ~20 MB uncompressed) would have passed this.
    const snapshot = buildSnapshot(9 * 1024 * 1024, () =>
      randomBytes(48 * 1024).toString('base64'),
    );
    const service = makeService(snapshot);

    const err = await service.bootstrap('hh-1', false).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    const body = (err as PayloadTooLargeException).getResponse() as {
      code: string;
      details: { gzippedBytes: number };
    };
    expect(body.code).toBe('BOOTSTRAP_TOO_LARGE');
    // The error reports the MEASURED gzipped size, and it is above the cap.
    expect(body.details.gzippedBytes).toBeGreaterThan(FIVE_MB);
  });

  it('passes the same uncompressed volume when it is highly compressible (gzips under 5 MB)', async () => {
    // ~12 MB uncompressed of a single repeated character → gzips to a tiny
    // fraction, well under the 5 MB compressed cap, so bootstrap succeeds.
    const snapshot = buildSnapshot(12 * 1024 * 1024, () => 'a'.repeat(64 * 1024));
    const service = makeService(snapshot);

    const res = await service.bootstrap('hh-1', false);
    expect(res.snapshotId).toBe('snap-1');
    expect(res.workspaceSnapshot.aggregates.length).toBeGreaterThan(0);
  });
});
