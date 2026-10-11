/**
 * Controllable fake `SyncTransport` shared by the SyncContext test files.
 *
 * Kept free of any `SyncContext` import on purpose: each test file's
 * `vi.mock('./mock-sync', ...)` factory loads this module, and loading
 * `SyncContext` from inside that factory would deadlock on the mock itself.
 */
import type {
  BootstrapResponseBody,
  PullResponseBody,
  PushResponseBody,
  SnapshotListItem,
} from './types';
import type { SyncTransport } from './sync-client';

export class FakeTransport implements SyncTransport {
  pushImpl: (args: Parameters<SyncTransport['push']>[0]) => Promise<PushResponseBody> = async (args) => ({
    applied: args.mutations.map((m) => ({
      status: 'applied' as const,
      mutationId: m.id,
      aggregateId: m.aggregateId,
      newVersion: m.expectedVersion + 1,
      newUpdatedAt: new Date().toISOString(),
    })),
    rejected: [],
    syncCursor: '0',
  });

  pullImpl: (args: Parameters<SyncTransport['pull']>[0]) => Promise<PullResponseBody> = async () => ({
    changes: [],
    newCursor: '0',
    hasMore: false,
  });

  bootstrapImpl: (
    args: Parameters<SyncTransport['bootstrap']>[0],
  ) => Promise<BootstrapResponseBody & { quarantined?: readonly { aggregateId: string; aggregateType: string }[] }> = async () => ({
    snapshotId: null,
    workspaceSnapshot: { householdId: 'mock', aggregates: [] },
    postSnapshotMutations: [],
    syncCursor: '0',
    timestamp: new Date().toISOString(),
  });

  listSnapshotsImpl: () => Promise<SnapshotListItem[]> = async () => [];
  restoreImpl: (snapshotId: string) => Promise<{ ok: boolean }> = async () => ({
    ok: true,
  });
  clearWorkspaceImpl: (
    args: Parameters<SyncTransport['clearWorkspace']>[0],
  ) => Promise<{ ok: boolean; historyErased: boolean }> = async () => ({
    ok: true,
    historyErased: true,
  });

  push(args: Parameters<SyncTransport['push']>[0]): Promise<PushResponseBody> {
    return this.pushImpl(args);
  }
  pull(args: Parameters<SyncTransport['pull']>[0]): Promise<PullResponseBody> {
    return this.pullImpl(args);
  }
  bootstrap(
    args: Parameters<SyncTransport['bootstrap']>[0],
  ): Promise<BootstrapResponseBody & { quarantined?: readonly { aggregateId: string; aggregateType: string }[] }> {
    return this.bootstrapImpl(args);
  }
  listSnapshots(): Promise<SnapshotListItem[]> {
    return this.listSnapshotsImpl();
  }
  restore(snapshotId: string): Promise<{ ok: boolean }> {
    return this.restoreImpl(snapshotId);
  }
  clearWorkspace(
    args: Parameters<SyncTransport['clearWorkspace']>[0],
  ): Promise<{ ok: boolean; historyErased: boolean }> {
    return this.clearWorkspaceImpl(args);
  }
}

export const fake = new FakeTransport();

export const mockSyncModule = {
  MockSyncClient: class {
    push(args: Parameters<SyncTransport['push']>[0]) { return fake.push(args); }
    pull(args: Parameters<SyncTransport['pull']>[0]) { return fake.pull(args); }
    bootstrap(args: Parameters<SyncTransport['bootstrap']>[0]) { return fake.bootstrap(args); }
    listSnapshots() { return fake.listSnapshots(); }
    restore(snapshotId: string) { return fake.restore(snapshotId); }
    clearWorkspace(args: Parameters<SyncTransport['clearWorkspace']>[0]) {
      return fake.clearWorkspace(args);
    }
  },
};
