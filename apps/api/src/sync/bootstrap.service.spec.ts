// A forced bootstrap writes no metric on any stack: no EMF line reaches stdout, and the ordinary incident log (without the old sync_bootstrap_forced marker message) is retained.
// Every collaborator is stubbed; sync.spec.ts covers the wire behaviour.
import 'reflect-metadata';
import fs from 'node:fs';
import { Logger } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service.js';
import type { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import type { SnapshotsService } from './snapshots.service.js';
import type { WorkspaceMetaRow } from '../dynamo/types.js';

const HOUSEHOLD_ID = 'household-abc';

function metaRow(): WorkspaceMetaRow {
  return {
    householdId: HOUSEHOLD_ID,
    latestSnapshotId: null,
    latestSnapshotCursor: null,
    latestVersion: 0,
    lastUpdatedAt: new Date().toISOString(),
    mutationLogCursorBase: null,
  };
}

function buildService(): BootstrapService {
  const meta = {
    createIfMissing: jest.fn().mockResolvedValue(metaRow()),
  } as unknown as WorkspaceMetaRepository;
  const log = {
    pageSince: jest
      .fn()
      .mockResolvedValue({ items: [], hasMore: false, lastSequenceId: null }),
  } as unknown as MutationLogRepository;
  const snapshots = {
    fetch: jest.fn().mockResolvedValue(null),
  } as unknown as SnapshotsService;
  return new BootstrapService(meta, log, snapshots);
}

function captureEmfMetricNames(): {
  names: string[];
  restore: () => void;
} {
  const names: string[] = [];
  // The writer emits EMF via `fs.writeSync(1, ...)`, so capture at that layer and pass other fds through.
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd !== 1) {
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }
    try {
      const parsed = JSON.parse(String(data)) as {
        _aws?: { CloudWatchMetrics: { Metrics: { Name: string }[] }[] };
      };
      if (parsed._aws) {
        names.push(parsed._aws.CloudWatchMetrics[0].Metrics[0].Name);
      }
    } catch {
    }
    return Buffer.byteLength(String(data));
  }) as unknown as typeof fs.writeSync);
  return { names, restore: () => spy.mockRestore() };
}

describe('BootstrapService — forced-bootstrap incident log', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes no EMF metric line when forced=true, whatever the stack', async () => {
    const cap = captureEmfMetricNames();
    try {
      await buildService().bootstrap(HOUSEHOLD_ID, true);
      expect(cap.names).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('no longer emits the old sync_bootstrap_forced log marker', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await buildService().bootstrap(HOUSEHOLD_ID, true);
    expect(logSpy).not.toHaveBeenCalledWith(
      'sync_bootstrap_forced',
      expect.anything(),
    );
    expect(logSpy).toHaveBeenCalledWith('Forced bootstrap requested', {
      householdId: HOUSEHOLD_ID,
    });
  });
});
