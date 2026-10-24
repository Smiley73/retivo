// Shared harness for the SyncContext tests: the fake transport, the probe, `renderProvider`, the reset hooks and the seeding
// helpers. Each test file declares its own hoisted `vi.mock('./mock-sync')` pointing at `mockSyncModule`.
import 'fake-indexeddb/auto';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { dropLocalDatabase, queueMutation, writeDeviceMetadata } from '../db/store';
import type { PendingMutation } from '../db/types';
import { SyncProvider, useSync } from './SyncContext';
import { fake } from './sync-context.test-fake';

export { fake };

export function Probe() {
  const sync = useSync();
  // Surfaces the structured error envelope so tests can assert SyncApiError fields flow into the badge state.
  const errorJson = sync.state.kind === 'error' ? JSON.stringify(sync.state) : '';
  return (
    <div>
      <div data-testid="state">{sync.state.kind}</div>
      <div data-testid="error-detail">{errorJson}</div>
      <div data-testid="pending">{sync.pendingCount}</div>
      <div data-testid="conflicts">{sync.conflictCount}</div>
      <div data-testid="next-retry-at">{sync.nextRetryAt ?? ''}</div>
      <button onClick={() => void sync.notifyPending()}>notifyPending</button>
      <button onClick={() => void sync.forceRefresh()}>forceRefresh</button>
      <button onClick={() => void sync.retryNow()}>retryNow</button>
      <button onClick={() => void sync.syncRoundTrip()}>syncRoundTrip</button>
      <button onClick={() => void sync.checkAndRepair()}>checkAndRepair</button>
    </div>
  );
}

export interface RenderProviderOptions {
  householdId?: string | null;
  probe?: ReactNode;
  onDeviceMismatch?: () => void | Promise<void>;
}

export function renderProvider(opts: RenderProviderOptions = {}) {
  const { householdId = 'hh-1', probe = <Probe />, onDeviceMismatch } = opts;
  return render(
    <SyncProvider
      householdId={householdId}
      deviceId="dev-test"
      apiBaseUrl=""
      getAccessToken={() => 'tok'}
      getCsrfToken={() => 'csrf'}
      onDeviceMismatch={onDeviceMismatch}
      mock
    >
      {probe}
    </SyncProvider>,
  );
}

// `dropLocalDatabase`, not `clearAllStores`, so deviceMetadata resets too: a leftover syncCursor from one test would make the
// next initialSync pull instead of bootstrap and race the test's own forceRefresh.
export function useSyncTestHooks(bootstrapHouseholdId = 'mock') {
  beforeEach(async () => {
    await dropLocalDatabase();
    fake.pushImpl = async (args) => ({
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
    fake.pullImpl = async () => ({ changes: [], newCursor: '0', hasMore: false });
    fake.bootstrapImpl = async () => ({
      snapshotId: null,
      workspaceSnapshot: { householdId: bootstrapHouseholdId, aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '0',
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await dropLocalDatabase();
    vi.restoreAllMocks();
  });
}

export async function seedMutation(over: Partial<PendingMutation> = {}): Promise<PendingMutation> {
  const m: PendingMutation = {
    id: over.id ?? `mut-${Math.random().toString(36).slice(2)}`,
    aggregateId: over.aggregateId ?? 'agg-1',
    aggregateType: over.aggregateType ?? 'account',
    operation: over.operation ?? 'create',
    expectedVersion: over.expectedVersion ?? 0,
    schemaVersion: over.schemaVersion ?? 1,
    payload: over.payload ?? { name: 'Test' },
    timestamp: over.timestamp ?? Date.now(),
    deviceId: over.deviceId ?? 'dev-1',
    status: over.status ?? 'pending',
  };
  await queueMutation(m);
  return m;
}

// Pre-seeds a non-zero cursor and a no-op pull so the mount-time `initialSync` takes the `pull()` branch and settles to
// `synced` before any test action; a bare render only proves the probe mounted, and the click then races the mount sync.
export async function renderSettled(renderFn: () => unknown): Promise<void> {
  await writeDeviceMetadata({
    deviceId: 'dev-test',
    syncCursor: 'seed-cursor',
    lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
    displayName: 'This device',
  });
  fake.pullImpl = async () => ({
    changes: [],
    newCursor: 'seed-cursor',
    hasMore: false,
  });
  renderFn();
  await waitFor(() =>
    expect(screen.getByTestId('state')).toHaveTextContent('synced'),
  );
}

