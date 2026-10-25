// A transient transaction cancel (TransactionConflict, throttling: no ConditionalCheckFailed reason) must be rethrown as a 5xx so the client retries, never fabricated into a CONFLICT cached for 7 days.
// A unit test with a crafted TransactionCanceledException, since the emulator cannot produce a TransactionConflict deterministically.
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PushService } from '../sync/push.service.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { PushMutationDto } from '../sync/dto/push.dto.js';

function encryptedEnvelope(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

function mutation(): PushMutationDto {
  return {
    id: randomUUID(),
    aggregateId: 'agg-1',
    aggregateType: 'account',
    operation: 'create',
    version: 0,
    schemaVersion: 1,
    payload: encryptedEnvelope(),
    timestamp: Date.now(),
    deviceId: randomUUID(),
  };
}

describe('PushService — transient transaction cancel', () => {
  it('rethrows on a TransactionConflict cancel and writes NO idempotency row', async () => {
    const householdId = 'hh-1';
    const deviceId = randomUUID();

    const sentCommands: unknown[] = [];

    const transientCancel = new TransactionCanceledException({
      message: 'Transaction cancelled, please refer to CancellationReasons',
      $metadata: {},
      CancellationReasons: [
        { Code: 'TransactionConflict' },
        { Code: 'TransactionConflict' },
        { Code: 'TransactionConflict' },
      ],
    });

    const doc = {
      send: jest.fn(async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof TransactWriteCommand) {
          throw transientCancel;
        }
        if (command instanceof GetCommand) {
          return { Item: undefined };
        }
        return {};
      }),
    } as unknown as DynamoDBDocumentClient;

    const idem = {
      lookup: jest.fn(async () => null),
    } as unknown as IdempotencyKeyRepository;

    const meta = {
      createIfMissing: jest.fn(async () => ({})),
      bumpVersionIfHigher: jest.fn(async () => undefined),
      find: jest.fn(async () => null),
      chargeDailyQuota: jest.fn(async () => ({ ok: true })),
    } as unknown as WorkspaceMetaRepository;

    const config = {
      get: (key: string) => key,
    } as unknown as ConfigService;

    const service = new PushService(doc, idem, meta, config as never);

    await expect(
      service.push({
        householdId,
        deviceId,
        mutations: [mutation()],
        freshnessHead: { freshnessCounter: 1, cursorTag: 'a'.repeat(43) },
      }),
    ).rejects.toBe(transientCancel);

    // The only TransactWriteCommand sent was the apply transaction that threw; buildConflictOutcome (which would send the idempotency-key Put) was never reached, so a retry can still succeed.
    const transactWrites = sentCommands.filter(
      (c) => c instanceof TransactWriteCommand,
    );
    expect(transactWrites).toHaveLength(1);
  });
});
