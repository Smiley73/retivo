import 'fake-indexeddb/auto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  clearAllStores,
  clearMutationQueue,
  listPendingMutations,
  putAggregate,
  subscribeToStoreChanges,
} from '../db/store';
import { setRegisteredDeviceId } from '../sync/device-id';
import {
  createScenario,
  deleteScenarioCascade,
  promoteScenario,
  reconcileScenarios,
  saveScenario,
} from './scenario-mutations';
import type { ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-test';
const PROMOTION_MARKER_KEY = 'retivo.scenarios.promotionInProgress';

function makeScenario(
  id: string,
  payload: Partial<ScenarioPayload> & { name: string },
  overrides: Partial<ScenarioAggregate> = {},
): ScenarioAggregate {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: payload.name,
      description: payload.description ?? '',
      parentScenarioId: payload.parentScenarioId ?? null,
      isPrimary: payload.isPrimary ?? false,
      notes: payload.notes ?? '',
      overrides: payload.overrides ?? {},
    },
    ...overrides,
  };
}

async function seed(scenario: ScenarioAggregate): Promise<void> {
  await putAggregate('scenario', scenario);
}

beforeEach(async () => {
  setRegisteredDeviceId('dev-test');
  await clearAllStores();
  await clearMutationQueue();
  localStorage.removeItem(PROMOTION_MARKER_KEY);
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
  localStorage.removeItem(PROMOTION_MARKER_KEY);
  vi.restoreAllMocks();
});

describe('saveScenario', () => {
  it('queues an update mutation at the scenario version', async () => {
    const s = makeScenario('s1', { name: 'X' }, { version: 5 });
    await seed(s);
    await saveScenario({
      scenario: s,
      payload: { ...s.payload, name: 'Y' },
      householdId: HH,
    });
    const queue = await listPendingMutations();
    expect(queue).toHaveLength(1);
    expect(queue[0].operation).toBe('update');
    expect(queue[0].expectedVersion).toBe(5);
    expect(queue[0].aggregateId).toBe('s1');
  });
});

describe('createScenario', () => {
  it('queues a create mutation at version 0 with a non-primary payload', async () => {
    await createScenario({
      id: 'sc-new',
      name: 'Aggressive',
      parentScenarioId: 'p',
      householdId: HH,
    });
    const queue = await listPendingMutations();
    expect(queue).toHaveLength(1);
    expect(queue[0].operation).toBe('create');
    expect(queue[0].expectedVersion).toBe(0);
    const payload = queue[0].payload as ScenarioPayload;
    expect(payload.isPrimary).toBe(false);
    expect(payload.parentScenarioId).toBe('p');
    expect(payload.notes).toBe('');
    expect(payload.overrides).toEqual({});
  });
});

describe('deleteScenarioCascade', () => {
  it('recursively deletes the target plus every transitive descendant', async () => {
    // Base -> A -> B, A -> C, B -> D
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    const b = makeScenario('b', { name: 'B', parentScenarioId: 'a' });
    const c = makeScenario('c', { name: 'C', parentScenarioId: 'a' });
    const d = makeScenario('d', { name: 'D', parentScenarioId: 'b' });
    await seed(primary);
    await seed(a);
    await seed(b);
    await seed(c);
    await seed(d);

    await deleteScenarioCascade('a', [primary, a, b, c, d], HH);

    const queue = await listPendingMutations();
    expect(queue).toHaveLength(4);
    expect(queue.every((m) => m.operation === 'delete')).toBe(true);
    expect(new Set(queue.map((m) => m.aggregateId))).toEqual(
      new Set(['a', 'b', 'c', 'd']),
    );
  });

  it('queues descendants leaf-first so no scenario is ever pointing at a deleted parent', async () => {
    // Base -> A -> B -> D
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    const b = makeScenario('b', { name: 'B', parentScenarioId: 'a' });
    const d = makeScenario('d', { name: 'D', parentScenarioId: 'b' });
    await seed(primary);
    await seed(a);
    await seed(b);
    await seed(d);

    // listPendingMutations reads via an IDB index ordered by mutation UUID, not insertion; mock Date.now() so each mutation gets a distinct increasing timestamp.
    let now = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    try {
      await deleteScenarioCascade('a', [primary, a, b, d], HH);
    } finally {
      dateNowSpy.mockRestore();
    }

    const queue = await listPendingMutations();
    const order = queue
      .slice()
      .sort((x, y) => x.timestamp - y.timestamp)
      .map((m) => m.aggregateId);
    expect(order).toEqual(['d', 'b', 'a']);
  });

  it('handles a leaf delete (no descendants) as a single delete mutation', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    await seed(primary);
    await seed(a);

    await deleteScenarioCascade('a', [primary, a], HH);

    const queue = await listPendingMutations();
    expect(queue).toHaveLength(1);
    expect(queue[0].operation).toBe('delete');
    expect(queue[0].aggregateId).toBe('a');
  });

  it('refuses to delete the base scenario', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    await seed(primary);
    await expect(
      deleteScenarioCascade('p', [primary], HH),
    ).rejects.toThrow(/base/i);
  });
});

describe('promoteScenario', () => {
  it('queues update on promoted, delete on old base, and re-parent on every survivor', async () => {
    const primary = makeScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    const b = makeScenario('b', {
      name: 'B',
      parentScenarioId: 'a',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const sibling = makeScenario('s', { name: 'Sibling', parentScenarioId: 'p' });
    await seed(primary);
    await seed(a);
    await seed(b);
    await seed(sibling);

    await promoteScenario('b', [primary, a, b, sibling], HH);

    const queue = await listPendingMutations();
    expect(queue).toHaveLength(4);
    const promotedUpdate = queue.find(
      (m) => m.aggregateId === 'b' && m.operation === 'update',
    );
    expect(promotedUpdate).toBeDefined();
    const promotedPayload = promotedUpdate?.payload as ScenarioPayload;
    expect(promotedPayload.isPrimary).toBe(true);
    expect(promotedPayload.parentScenarioId).toBeNull();
    expect(promotedPayload.overrides.retirementAge?.primary.ageYears).toBe(60);

    const deletion = queue.find((m) => m.operation === 'delete');
    expect(deletion?.aggregateId).toBe('p');

    const reParents = queue.filter(
      (m) => m.operation === 'update' && m.aggregateId !== 'b',
    );
    expect(reParents).toHaveLength(2);
    for (const r of reParents) {
      const p = r.payload as ScenarioPayload;
      expect(p.parentScenarioId).toBe('b');
    }
  });

  it('clears the promotion marker after queuing all mutations', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    await seed(primary);
    await seed(a);
    await promoteScenario('a', [primary, a], HH);
    expect(localStorage.getItem(PROMOTION_MARKER_KEY)).toBeNull();
  });

  it('refuses to promote the base scenario', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    await seed(primary);
    await expect(
      promoteScenario('p', [primary], HH),
    ).rejects.toThrow(/base/i);
  });

  // The cascade threads its writes through one withBatchedStoreSignals scope, so its 4 scenario writes fire the fine `scenario` signal once, not once per saveScenario.
  it('fires exactly one fine scenario store signal for the whole cascade, not one per write', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    const b = makeScenario('b', { name: 'B', parentScenarioId: 'a' });
    const sibling = makeScenario('s', { name: 'Sibling', parentScenarioId: 'p' });
    await seed(primary);
    await seed(a);
    await seed(b);
    await seed(sibling);

    const scenariosListener = vi.fn();
    const unsubscribe = subscribeToStoreChanges('scenarios', scenariosListener);

    await promoteScenario('b', [primary, a, b, sibling], HH);

    expect(scenariosListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('reconcileScenarios', () => {
  it('demotes losing duplicate base scenario by updatedAt', async () => {
    const winner = makeScenario(
      'w',
      { name: 'Winner', isPrimary: true },
      { updatedAt: '2026-05-10T12:00:00Z' },
    );
    const loser = makeScenario(
      'l',
      { name: 'Loser', isPrimary: true },
      { updatedAt: '2026-05-09T12:00:00Z' },
    );
    await seed(winner);
    await seed(loser);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await reconcileScenarios([winner, loser], HH);

    expect(summary.duplicatePrimariesDemoted).toBe(1);
    const queue = await listPendingMutations();
    const update = queue.find((m) => m.aggregateId === 'l');
    expect(update).toBeDefined();
    const payload = update?.payload as ScenarioPayload;
    expect(payload.isPrimary).toBe(false);
    expect(payload.parentScenarioId).toBe('w');
  });

  it('re-parents scenarios with dangling parent ids to the current base scenario', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const orphan = makeScenario('o', { name: 'Orphan', parentScenarioId: 'gone' });
    await seed(primary);
    await seed(orphan);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await reconcileScenarios([primary, orphan], HH);

    expect(summary.danglingParentsRehomed).toBe(1);
    const queue = await listPendingMutations();
    const update = queue.find((m) => m.aggregateId === 'o');
    const payload = update?.payload as ScenarioPayload;
    expect(payload.parentScenarioId).toBe('p');
  });

  it('is a no-op on a healthy tree', async () => {
    const primary = makeScenario('p', { name: 'Base', isPrimary: true });
    const a = makeScenario('a', { name: 'A', parentScenarioId: 'p' });
    await seed(primary);
    await seed(a);

    const summary = await reconcileScenarios([primary, a], HH);

    expect(summary.duplicatePrimariesDemoted).toBe(0);
    expect(summary.danglingParentsRehomed).toBe(0);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('skips the sweep when another tab holds the cross-tab lock', async () => {
    const winner = makeScenario(
      'w',
      { name: 'Winner', isPrimary: true },
      { updatedAt: '2026-05-10T12:00:00Z' },
    );
    const loser = makeScenario(
      'l',
      { name: 'Loser', isPrimary: true },
      { updatedAt: '2026-05-09T12:00:00Z' },
    );
    await seed(winner);
    await seed(loser);

    // A peer tab inside `reconcileScenarios`: the recency check ignores stale locks (a crashed tab), so the timestamp must be fresh.
    localStorage.setItem(
      'retivo.scenarios.reconcileLock',
      String(Date.now()),
    );
    try {
      const summary = await reconcileScenarios([winner, loser], HH);
      expect(summary.duplicatePrimariesDemoted).toBe(0);
      expect(summary.danglingParentsRehomed).toBe(0);
      expect(await listPendingMutations()).toHaveLength(0);
    } finally {
      localStorage.removeItem('retivo.scenarios.reconcileLock');
    }
  });

  it('runs when an existing lock is older than the stale threshold (crashed peer)', async () => {
    const winner = makeScenario(
      'w',
      { name: 'Winner', isPrimary: true },
      { updatedAt: '2026-05-10T12:00:00Z' },
    );
    const loser = makeScenario(
      'l',
      { name: 'Loser', isPrimary: true },
      { updatedAt: '2026-05-09T12:00:00Z' },
    );
    await seed(winner);
    await seed(loser);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    localStorage.setItem(
      'retivo.scenarios.reconcileLock',
      String(Date.now() - 60_000),
    );
    try {
      const summary = await reconcileScenarios([winner, loser], HH);
      expect(summary.duplicatePrimariesDemoted).toBe(1);
    } finally {
      localStorage.removeItem('retivo.scenarios.reconcileLock');
    }
  });
});
