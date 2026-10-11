/**
 * Shared harness for the SyncContext test files (test-only; not shipped).
 *
 * Re-exports the controllable fake transport and provides the probe, the
 * single `renderProvider`, the per-describe reset hooks and the seeding /
 * settle helpers. Each SyncContext test file still declares its own
 * `vi.mock('./mock-sync', ...)` (it must be hoisted in the test file itself)
 * pointing at `mockSyncModule` from `./sync-context.test-fake`.
 */
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
  // Surface the structured error envelope so tests can assert that
  // SyncApiError fields (code/traceId/status/phase) flow into the
  // badge state — the SyncBadge popover relies on this end-to-end.
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
  /** Probe component tree to mount; defaults to the shared `Probe`. */
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

/**
 * The shared per-describe reset. Call once at the top of a `describe`.
 *
 * `dropLocalDatabase` (not `clearAllStores`) so deviceMetadata is also reset
 * between tests. `clearAllStores` deliberately preserves deviceMetadata for
 * production force-bootstrap semantics; here we need a true clean slate so
 * that one test writing syncCursor=42 (e.g. the bootstrap-success case) does
 * not bleed into the next test's initialSync — which would skip bootstrap,
 * run pull, and race against the test's own click-driven forceRefresh.
 */
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

/**
 * Deterministic-settle render harness for mount-then-act tests.
 *
 * A bare `renderProvider()` + `await screen.findByTestId('state')` only
 * proves the probe MOUNTED — not that the mount-time `initialSync`
 * (bootstrap/pull) SETTLED. The click-driven action then races the
 * still-in-flight mount sync (shared `fake.*Impl`, store state, one-shot
 * spies) under microtask pressure → intermittent failures.
 *
 * This helper removes the race: it pre-seeds a non-zero
 * `deviceMetadata.syncCursor` (deviceId matching every `render*Provider`
 * here, all `deviceId="dev-test"`) and a cursor-preserving no-op
 * `fake.pullImpl`, so the mount-time `initialSync` deterministically
 * takes the `pull()` branch (cursor present and ≠ '0' in
 * `SyncContext.initialSync`) and FULLY settles to `synced` BEFORE any
 * test action. The caller then installs its per-case bootstrap/pull
 * behaviour and clicks. Pass the block's own `render*Provider`.
 */
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

