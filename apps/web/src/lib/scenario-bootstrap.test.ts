import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ensureBaseScenario,
  DEFAULT_RETIREMENT_AGE,
  DEFAULT_SOCIAL_SECURITY_CLAIM_AGE,
  BASE_SCENARIO_NAME,
} from './scenario-bootstrap';
import {
  clearAllStores,
  clearMutationQueue,
  listAggregates,
  listPendingMutations,
} from '../db/store';
import { setRegisteredDeviceId } from '../sync/device-id';
import {
  resolveScenario,
  type ScenarioAggregate,
} from './scenario-resolution';
import type { ScenarioPayload } from '../db/types';

const HOUSEHOLD_ID = 'h1';

beforeEach(async () => {
  setRegisteredDeviceId('test-device');
  await clearAllStores();
  await clearMutationQueue();
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
});

describe('ensureBaseScenario', () => {
  it('creates a base scenario when no scenarios exist', async () => {
    const id = await ensureBaseScenario(HOUSEHOLD_ID);
    expect(id).not.toBeNull();

    const scenarios = await listAggregates('scenario');
    expect(scenarios).toHaveLength(1);
    const payload = scenarios[0].payload as ScenarioPayload;
    expect(payload.name).toBe(BASE_SCENARIO_NAME);
    expect(payload.isPrimary).toBe(true);
    expect(payload.parentScenarioId).toBeNull();
    expect(payload.notes).toBe('');
    expect(payload.overrides.retirementAge).toEqual(DEFAULT_RETIREMENT_AGE);
    expect(payload.overrides.socialSecurity).toEqual(DEFAULT_SOCIAL_SECURITY_CLAIM_AGE);
    expect(payload.overrides.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
  });

  it('queues a `create` mutation at expectedVersion 0', async () => {
    await ensureBaseScenario(HOUSEHOLD_ID);
    const queue = await listPendingMutations();
    expect(queue).toHaveLength(1);
    expect(queue[0].operation).toBe('create');
    expect(queue[0].expectedVersion).toBe(0);
    expect(queue[0].aggregateType).toBe('scenario');
  });

  it('is a no-op when a base scenario already exists', async () => {
    const firstId = await ensureBaseScenario(HOUSEHOLD_ID);
    expect(firstId).not.toBeNull();

    const secondId = await ensureBaseScenario(HOUSEHOLD_ID);
    expect(secondId).toBeNull();

    const scenarios = await listAggregates('scenario');
    expect(scenarios).toHaveLength(1);
  });

  it('is a no-op when any scenario already exists', async () => {
    await ensureBaseScenario(HOUSEHOLD_ID);
    const queue = await listPendingMutations();
    expect(queue).toHaveLength(1);

    const result = await ensureBaseScenario(HOUSEHOLD_ID);
    expect(result).toBeNull();
    expect(await listAggregates('scenario')).toHaveLength(1);
  });

  it('non-base scenario with no ss override resolves to 67y0m via read-time fallback', () => {
    // The base scenario seeds `overrides.socialSecurity.primary` at bootstrap; a non-base scenario that overrides nothing resolves no SS section, so consumers apply the read-time fallback `{ ageYears: 67, ageMonths: 0 }`.
    const nonBase: ScenarioAggregate = {
      id: 'scen-alt',
      householdId: HOUSEHOLD_ID,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Alternate',
        description: '',
        parentScenarioId: null,
        isPrimary: false,
        notes: '',
        overrides: {},
      },
    };
    const resolved = resolveScenario('scen-alt', [nonBase]);
    expect(resolved.socialSecurity).toBeUndefined();
    const claimAgePrimary =
      resolved.socialSecurity?.primary ?? { ageYears: 67, ageMonths: 0 };
    expect(claimAgePrimary).toEqual({ ageYears: 67, ageMonths: 0 });
  });
});
