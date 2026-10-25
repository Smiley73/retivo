// TOCTOU-safe rejection-cache replay corner cases the emulator cannot race deterministically: a concurrent corrected retry that applied while this conditional delete was in flight replays the applied result
// (never a fabricated CONFLICT), a delete failure that finds a fresh rejection replays that one, and idem.delete(key, expectedVersion) is wired exactly. Stubbed document client and repository control the interleaving.
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PushService } from '../sync/push.service.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { PushMutationDto } from '../sync/dto/push.dto.js';
import type {
  AppliedMutationResult,
  IdempotencyKeyRow,
  RejectedMutationResult,
} from '../dynamo/types.js';

function encryptedEnvelope(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

function mutation(overrides: Partial<PushMutationDto> = {}): PushMutationDto {
  return {
    id: randomUUID(),
    aggregateId: randomUUID(),
    aggregateType: 'account',
    operation: 'update',
    version: 1,
    schemaVersion: 1,
    payload: encryptedEnvelope(),
    timestamp: Date.now(),
    deviceId: 'dev-1',
    ...overrides,
  };
}

function rejectionRow(expectedVersion: number | undefined): IdempotencyKeyRow {
  const response: RejectedMutationResult = {
    status: 'rejected',
    mutationId: randomUUID(),
    aggregateId: randomUUID(),
    reason: 'CONFLICT',
    currentVersion: 0,
    currentUpdatedAt: new Date().toISOString(),
    currentDeletedAt: null,
  };
  return {
    key: 'k',
    response,
    createdAt: new Date().toISOString(),
    expiresAt: 0,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
}

function appliedRow(newVersion: number): IdempotencyKeyRow {
  const response: AppliedMutationResult = {
    status: 'applied',
    mutationId: randomUUID(),
    aggregateId: randomUUID(),
    newVersion,
    newUpdatedAt: new Date().toISOString(),
  };
  return { key: 'k', response, createdAt: new Date().toISOString(), expiresAt: 0 };
}

const FRESHNESS = { freshnessCounter: 1, cursorTag: 'a'.repeat(43) };

interface Harness {
  service: PushService;
  lookup: jest.Mock;
  del: jest.Mock;
  transactCommands: TransactWriteCommand[];
}

function buildHarness(opts: {
  firstLookup: IdempotencyKeyRow;
  deleteResult: boolean;
  secondLookup?: IdempotencyKeyRow | null;
}): Harness {
  const transactCommands: TransactWriteCommand[] = [];
  const doc = {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        transactCommands.push(command);
        return {}; // apply commits
      }
      return {};
    }),
  } as unknown as DynamoDBDocumentClient;

  const lookup = jest
    .fn()
    .mockResolvedValueOnce(opts.firstLookup)
    .mockResolvedValueOnce(opts.secondLookup ?? null);
  const del = jest.fn().mockResolvedValue(opts.deleteResult);
  const idem = { lookup, delete: del } as unknown as IdempotencyKeyRepository;

  const meta = {
    createIfMissing: jest.fn(async () => ({})),
    bumpVersionIfHigher: jest.fn(async () => undefined),
    bumpFreshnessHead: jest.fn(async () => null),
    find: jest.fn(async () => null), // no compaction cursor → no strand re-append noise
    chargeDailyQuota: jest.fn(async () => ({ ok: true })),
  } as unknown as WorkspaceMetaRepository;

  const config = { get: (key: string) => key } as unknown as ConfigService;

  return {
    service: new PushService(doc, idem, meta, config as never),
    lookup,
    del,
    transactCommands,
  };
}

describe('PushService — rejection-cache TOCTOU', () => {
  it('a corrected retry whose conditional delete loses to a concurrent applied write replays the APPLIED result, never a fabricated CONFLICT', async () => {
    const { service, del, transactCommands } = buildHarness({
      firstLookup: rejectionRow(0), // cached at version 0
      deleteResult: false, // lost the race — already applied underneath
      secondLookup: appliedRow(7),
    });
    const m = mutation({ version: 1 }); // corrected version

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [m],
      freshnessHead: FRESHNESS,
    });

    expect(res.rejected).toHaveLength(0);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].newVersion).toBe(7);
    // The delete used the recorded (stale) expectedVersion, not the incoming one.
    expect(del).toHaveBeenCalledWith(expect.any(String), 0);
    // A pure replay re-applies nothing, so no fresh TransactWriteItems was attempted.
    expect(transactCommands).toHaveLength(0);
  });

  it('a conditional-delete failure that finds a FRESH rejection underneath replays that fresh rejection, not the stale one', async () => {
    const freshRejection = rejectionRow(1); // a NEW rejection at the corrected version
    const { service, transactCommands } = buildHarness({
      firstLookup: rejectionRow(0),
      deleteResult: false,
      secondLookup: freshRejection,
    });
    const m = mutation({ version: 1 });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [m],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]).toEqual(freshRejection.response);
    expect(transactCommands).toHaveLength(0);
  });

  it('a successful conditional delete re-applies the mutation fresh, writing a real TransactWriteItems', async () => {
    const { service, del, transactCommands } = buildHarness({
      firstLookup: rejectionRow(0),
      deleteResult: true,
    });
    const m = mutation({ version: 1 });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [m],
      freshnessHead: FRESHNESS,
    });

    expect(res.rejected).toHaveLength(0);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].newVersion).toBe(2); // m.version (1) + 1
    expect(del).toHaveBeenCalledWith(expect.any(String), 0);
    expect(transactCommands).toHaveLength(1);
  });
});
