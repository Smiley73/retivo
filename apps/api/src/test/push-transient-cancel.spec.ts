/**
 * Transient transaction cancels must not be cached as permanent
 * CONFLICTs. When a push's per-mutation TransactWriteItems is canceled
 * for a TRANSIENT reason (TransactionConflict from concurrent
 * transactions on the same item, throttling, …) — i.e. NO cancellation
 * reason is `ConditionalCheckFailed` — PushService must RETHROW so the
 * global exception filter returns a 5xx and the client retries. It must
 * NOT call buildConflictOutcome, which would fabricate a CONFLICT and
 * cache it in the idempotency table for 7 days, permanently rejecting a
 * valid mutation.
 *
 * Focused unit test (not an emulator integration test): the local
 * DynamoDB emulator cannot deterministically produce a TransactionConflict
 * cancellation, so we stub the document client to throw a crafted
 * `TransactionCanceledException` and assert (a) push rethrows and (b) no
 * idempotency row is written.
 */
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

    // Track every command the doc client receives so we can assert no
    // idempotency-row Put was attempted after the transient cancel.
    const sentCommands: unknown[] = [];

    // A cancel whose reasons are ALL TransactionConflict (transient) — no
    // ConditionalCheckFailed anywhere → classifyTransactCancel = 'unknown'.
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
          // The per-mutation apply transaction is the only TransactWrite in
          // this path; make it fail with the transient cancel.
          throw transientCancel;
        }
        if (command instanceof GetCommand) {
          // fetchCurrentVersion (only reached on the conflict path we must
          // NOT take) — return empty if ever called.
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

    // No idempotency row was cached: the only TransactWriteCommand sent was
    // the apply transaction that threw — buildConflictOutcome (which sends a
    // second TransactWriteCommand with the idempotency-key Put) was never
    // reached, so a retry of the same mutation can still succeed.
    const transactWrites = sentCommands.filter(
      (c) => c instanceof TransactWriteCommand,
    );
    expect(transactWrites).toHaveLength(1);
  });
});
