import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, queueMutation, writeDeviceMetadata } from '../../db/store';
import { CLIENT_BUILD_ID } from '../../lib/build-id';
import { ENGINE_VERSION } from '../../lib/monte-carlo';
import { TEST_NOW, callPlanTool, choicesWith, envelopeOf, planToolHandler, toolContext } from '../../test/assistant-tools';

interface StatusData {
  connection: { state: string; assistant?: string; connectedSince?: string };
  workspace: { state: string };
  app: { build: string; today: string };
  engine: { engineVersion: number; taxTableYear: number; taxTableYearExtrapolated: boolean };
  dataFreshness: { lastSyncedAt: string | null; pendingLocalChanges: number; meaning: string };
  sharing: Record<string, boolean>;
}

const status = async (choices = choicesWith()) => envelopeOf(await callPlanTool('retivo_status', {}, choices));

beforeAll(async () => {
  await clearAllStores();
  await writeDeviceMetadata({ deviceId: 'device-1', syncCursor: '0', lastSyncedAt: '2026-06-14T08:30:00.000Z', displayName: 'Laptop' });
});

describe('retivo_status', () => {
  it('reports the connection, workspace state, build, engine and tax tables', async () => {
    const data = (await status()).data as unknown as StatusData;
    expect(CLIENT_BUILD_ID).toBe('dev');
    expect(data.app).toEqual({ build: 'dev', today: '2026-06-15' });
    expect(data.connection).toMatchObject({ state: 'connected', assistant: 'Test Assistant', connectedSince: '2026-06-15T11:00:00.000Z' });
    expect(data.workspace).toEqual({ state: 'unlocked' });
    expect(data.engine.engineVersion).toBe(ENGINE_VERSION);
    expect(data.engine.taxTableYear).toBeGreaterThan(2000);
  });

  it('tells a synced workspace from one edited since, by the pending-mutation count', async () => {
    const before = (await status()).data as unknown as StatusData;
    expect(before.dataFreshness).toMatchObject({ lastSyncedAt: '2026-06-14T08:30:00.000Z', pendingLocalChanges: 0 });
    expect(before.dataFreshness.meaning).toMatch(/has synced/);
    await queueMutation({
      id: 'm-1',
      aggregateId: 'a-1',
      aggregateType: 'account',
      operation: 'update',
      expectedVersion: 1,
      schemaVersion: 1,
      payload: {},
      timestamp: 1,
      deviceId: 'device-1',
      status: 'pending',
    });
    const after = await status();
    expect((after.data as unknown as StatusData).dataFreshness).toMatchObject({ pendingLocalChanges: 1 });
    expect((after.data as unknown as StatusData).dataFreshness.meaning).toMatch(/not synced yet/);
    expect(after.dataAsOf).toEqual({ lastSyncedAt: '2026-06-14T08:30:00.000Z', pendingLocalChanges: 1 });
  });

  it('echoes the consent switches in effect', async () => {
    const choices = choicesWith({ notes: false, exactDollars: false });
    const data = (await status(choices)).data as unknown as StatusData;
    expect(data.sharing).toEqual(choices);
    expect(data.sharing.notes).toBe(false);
    expect(data.sharing.members).toBe(true);
  });

  it('sanitizes the assistant’s self-reported name and omits it when there is none', async () => {
    const handler = planToolHandler('retivo_status');
    const context = toolContext();
    const named = await handler({}, { ...context, connection: { assistantName: `Evil‮\u0000 ${'x'.repeat(100)}`, pairedAt: null } });
    const name = ((envelopeOf(named).data as unknown as StatusData).connection.assistant ?? '');
    expect(name).not.toMatch(/[‮\u0000]/);
    expect(Array.from(name).length).toBeLessThanOrEqual(60);
    const anonymous = await handler({}, { ...context, connection: { assistantName: null, pairedAt: null } });
    expect((envelopeOf(anonymous).data as unknown as StatusData).connection).toEqual({ state: 'connected' });
  });

  it('says when today’s tax year is later than the built-in tables', async () => {
    const current = (await status()).data as unknown as StatusData;
    const later = envelopeOf(await callPlanTool('retivo_status', {}, choicesWith(), new Date(current.engine.taxTableYear + 2, 2, 1)));
    expect((later.data as unknown as StatusData).engine.taxTableYearExtrapolated).toBe(true);
    expect(later.assumptions[0]).toMatch(/scale .* forward/);
    expect(TEST_NOW.getFullYear()).toBe(2026);
  });
});
