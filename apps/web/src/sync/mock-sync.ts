// In-process sync transport for browser-only mode: synthetic responses, no backend.
import type { SyncTransport } from './sync-client.js';
import type {
  BootstrapResponseBody,
  PullResponseBody,
  PushResponseBody,
  SnapshotListItem,
} from './types.js';

export class MockSyncClient implements SyncTransport {
  async push(args: Parameters<SyncTransport['push']>[0]): Promise<PushResponseBody> {
    await sleep(400);
    return {
      applied: args.mutations.map((m) => ({
        status: 'applied',
        mutationId: m.id,
        aggregateId: m.aggregateId,
        newVersion: m.expectedVersion + 1,
        newUpdatedAt: new Date().toISOString(),
      })),
      rejected: [],
      syncCursor: '0',
    };
  }

  async pull(): Promise<PullResponseBody> {
    return { changes: [], newCursor: '0', hasMore: false };
  }

  async bootstrap(): Promise<BootstrapResponseBody> {
    return {
      snapshotId: null,
      workspaceSnapshot: { householdId: 'mock-household', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '0',
      timestamp: new Date().toISOString(),
    };
  }

  async listSnapshots(): Promise<SnapshotListItem[]> {
    return [];
  }

  async restore(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async clearWorkspace(): Promise<{ ok: boolean; historyErased: boolean }> {
    return { ok: true, historyErased: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
