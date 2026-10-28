// TrustedDeviceRepository on DynamoDB Local: a missing (userId, deviceId) is null, put round-trips a row, listByUser queries by PK (no Scan) and returns only the caller's rows, and delete forgets one device.
import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import { TrustedDeviceRepository } from './trusted-device.repository.js';
import type { TrustedDeviceRow } from './types.js';

function makeRow(userId: string, deviceId: string): TrustedDeviceRow {
  return {
    userId,
    deviceId,
    tokenHash: 'c'.repeat(64),
    createdAt: '2026-06-12T00:00:00.000Z',
    // A numeric epoch-second TTL lets DynamoDB TTL auto-purge the row.
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400,
    lastUsedAt: '2026-06-12T00:00:00.000Z',
    ip: '203.0.113.7',
    userAgent: 'jest',
  };
}

describe('TrustedDeviceRepository', () => {
  let t: TestApp;
  let repo: TrustedDeviceRepository;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    repo = t.module.get(TrustedDeviceRepository);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('returns null for an untrusted (userId, deviceId)', async () => {
    expect(await repo.get(randomUUID(), randomUUID())).toBeNull();
  });

  it('round-trips a trust row through put + get', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const row = makeRow(userId, deviceId);
    await repo.put(row);
    const got = await repo.get(userId, deviceId);
    expect(got).toEqual(row);
    expect(typeof got?.expiresAt).toBe('number');
  });

  it('listByUser returns only the calling user rows and never another user', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const deviceA1 = randomUUID();
    const deviceA2 = randomUUID();
    await repo.put(makeRow(userA, deviceA1));
    await repo.put(makeRow(userA, deviceA2));
    await repo.put(makeRow(userB, randomUUID()));

    const listed = await repo.listByUser(userA);
    expect(listed).toHaveLength(2);
    expect(listed.every((r) => r.userId === userA)).toBe(true);
    expect(new Set(listed.map((r) => r.deviceId))).toEqual(new Set([deviceA1, deviceA2]));
  });

  it('deletes one device trust ("forget this device")', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    await repo.put(makeRow(userId, deviceId));
    await repo.delete(userId, deviceId);
    expect(await repo.get(userId, deviceId)).toBeNull();
  });

  it('stampLastUsed advances lastUsedAt on the stored row without touching other fields', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const row = makeRow(userId, deviceId);
    // A `lastUsedAt` earlier than the `createdAt` default means only a real UpdateItem against DynamoDB Local can pass; a stub cannot prove the UpdateExpression and Key shape land.
    row.lastUsedAt = '2020-01-01T00:00:00.000Z';
    await repo.put(row);

    await repo.stampLastUsed(userId, deviceId);

    const got = await repo.get(userId, deviceId);
    expect(got?.lastUsedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(got!.lastUsedAt)).toBeGreaterThan(Date.parse(row.createdAt));
    expect(got?.tokenHash).toBe(row.tokenHash);
    expect(got?.expiresAt).toBe(row.expiresAt);
  });

  describe('incrementFailure / clearFailure', () => {
    it('increments the per-device counter atomically and returns the new attributes', async () => {
      const userId = randomUUID();
      const deviceId = randomUUID();
      await repo.put(makeRow(userId, deviceId));

      const row = await repo.incrementFailure(userId, deviceId);
      expect(row?.consecutiveFailures).toBe(1);
      const row2 = await repo.incrementFailure(userId, deviceId);
      expect(row2?.consecutiveFailures).toBe(2);
    });

    it('is a no-op (returns null) when the device row does not exist — never mints a bare row', async () => {
      const userId = randomUUID();
      const deviceId = randomUUID();
      expect(await repo.incrementFailure(userId, deviceId)).toBeNull();
      expect(await repo.get(userId, deviceId)).toBeNull();
    });

    it('clearFailure removes the counter fields but leaves the trust row intact', async () => {
      const userId = randomUUID();
      const deviceId = randomUUID();
      await repo.put(makeRow(userId, deviceId));
      await repo.incrementFailure(userId, deviceId);

      await repo.clearFailure(userId, deviceId);

      const row = await repo.get(userId, deviceId);
      expect(row).not.toBeNull();
      expect(row?.consecutiveFailures).toBeUndefined();
      expect(row?.tokenHash).toBeDefined();
    });

    it('clearFailure on a device that was never trusted is a silent no-op', async () => {
      const userId = randomUUID();
      const deviceId = randomUUID();
      await expect(repo.clearFailure(userId, deviceId)).resolves.toBeUndefined();
      expect(await repo.get(userId, deviceId)).toBeNull();
    });
  });
});

// DynamoDB Local never reproduces replica lag, so an emulator test passes if strong consistency is dropped; the
// document client is stubbed to assert the Query parameters.
describe('TrustedDeviceRepository.listByUser read mode', () => {
  function stubbedRepo(sent: QueryCommand[]): TrustedDeviceRepository {
    const doc = {
      send: async (command: QueryCommand) => {
        sent.push(command);
        return { Items: [] };
      },
    } as unknown as DynamoDBDocumentClient;
    const config = { get: () => 'test-trusted-device-table' } as unknown as ConfigService<EnvConfig, true>;
    return new TrustedDeviceRepository(doc, config);
  }

  it('sends a strongly consistent Query when asked, and the default read otherwise', async () => {
    const sent: QueryCommand[] = [];
    const repo = stubbedRepo(sent);

    await repo.listByUser('user-1', { consistentRead: true });
    await repo.listByUser('user-1');

    expect(sent[0]).toBeInstanceOf(QueryCommand);
    expect(sent[0].input.ConsistentRead).toBe(true);
    expect(sent[1].input.ConsistentRead).toBeUndefined();
  });
});
