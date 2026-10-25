// The bootstrap size cap is 5 MB compressed, enforced on the actual gzipped size: the old `uncompressed > 5MB x 4` check assumed ~4:1 gzip, but ciphertext is incompressible,
// so it silently raised the cap to ~20 MB. The three repositories are stubbed, so no emulator is needed.
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

// High-entropy bytes barely shrink under gzip, so a >5 MB uncompressed total stays >5 MB gzipped (413); a compressible string of the same volume gzips far under 5 MB.
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
    pageSince: async () => ({ items: [], lastSequenceId: null, hasMore: false }),
  } as unknown as MutationLogRepository;
  const snapshots = {
    fetch: async () => ({ aggregates: snapshot, cutoff: '0' }),
  } as unknown as SnapshotsService;
  return new BootstrapService(meta, log, snapshots);
}

describe('BootstrapService — compressed size cap', () => {
  it('413s when the high-entropy (incompressible) response exceeds 5 MB gzipped', async () => {
    // ~9 MB of random base64 gzips to ~6.8 MB, above the cap; the old x4 allowance would have passed it.
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
    expect(body.details.gzippedBytes).toBeGreaterThan(FIVE_MB);
  });

  it('passes the same uncompressed volume when it is highly compressible (gzips under 5 MB)', async () => {
    const snapshot = buildSnapshot(12 * 1024 * 1024, () => 'a'.repeat(64 * 1024));
    const service = makeService(snapshot);

    const res = await service.bootstrap('hh-1', false);
    expect(res.snapshotId).toBe('snap-1');
    expect(res.workspaceSnapshot.aggregates.length).toBeGreaterThan(0);
  });
});
