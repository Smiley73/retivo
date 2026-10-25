// SessionRevocationService.revokeAll's generation boundary, driving retireCurrentGeneration's failure branches with a stubbed UsersRepository and document client (the emulator cannot produce a losing condition or a transient conflict):
// a missing User row fails closed with no bump or tombstone, and a bump that loses every bounded retry, or a transient cancellation outlasting runTransactWrite's retry, is 503 SESSION_REVOCATION_CONFLICT, not a 500.
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { EnvConfig } from '../common/env.config.js';
import { SessionRevocationService } from './session-revocation.service.js';
import type { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import type { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const USER_ID = 'user-1';

function stubConfig(): TypedConfig {
  return {
    get: jest.fn((key: string) => (key === 'AUTH_REFRESH_TOKEN_TTL_MIN' ? 60 : undefined)),
  } as unknown as TypedConfig;
}

function transactCancel(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled, please refer to CancellationReasons',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe('SessionRevocationService.revokeAll — retireCurrentGeneration boundary', () => {
  it('fails closed when the User row no longer exists, without ever attempting a bump or tombstone write', async () => {
    const users = {
      findByIdConsistent: jest.fn().mockResolvedValue(null),
    } as unknown as UsersRepository;
    const refreshTokens = {} as RefreshTokensRepository;
    const revoked = {} as RevokedTokensRepository;
    const doc = { send: jest.fn() } as unknown as DynamoDBDocumentClient;
    const svc = new SessionRevocationService(doc, refreshTokens, revoked, users, stubConfig());

    await expect(svc.revokeAll({ userId: USER_ID })).rejects.toThrow(
      `Cannot revoke sessions for ${USER_ID}: the account no longer exists`,
    );
    expect(doc.send).not.toHaveBeenCalled();
  });

  it('retries a losing generation-bump ConditionCheck up to the bound, then surfaces a 503 SESSION_REVOCATION_CONFLICT', async () => {
    const users = {
      findByIdConsistent: jest.fn().mockResolvedValue({ userId: USER_ID, sessionGeneration: 0 }),
      bumpSessionGenerationTransactItem: jest.fn().mockReturnValue({ Update: {} }),
    } as unknown as UsersRepository;
    const revoked = {
      tombstoneGenerationTransactItem: jest.fn().mockReturnValue({ Put: {} }),
    } as unknown as RevokedTokensRepository;
    const doc = {
      send: jest.fn().mockRejectedValue(transactCancel(['ConditionalCheckFailed', 'None'])),
    } as unknown as DynamoDBDocumentClient;
    const svc = new SessionRevocationService(
      doc,
      {} as RefreshTokensRepository,
      revoked,
      users,
      stubConfig(),
    );

    await expect(svc.revokeAll({ userId: USER_ID })).rejects.toMatchObject({
      response: { code: 'SESSION_REVOCATION_CONFLICT' },
    });
    // One consistent re-read and one doc.send per attempt: a losing ConditionCheck retries instead of failing on the first loss, and the re-read is strongly consistent because it follows another writer's commit to the same item.
    expect(users.findByIdConsistent).toHaveBeenCalledTimes(3);
    expect(doc.send).toHaveBeenCalledTimes(3);
  });

  it('surfaces the SAME 503 SESSION_REVOCATION_CONFLICT — not a 500 — when a transient cancellation survives the transaction\'s own bounded retry', async () => {
    const users = {
      findByIdConsistent: jest.fn().mockResolvedValue({ userId: USER_ID, sessionGeneration: 0 }),
      bumpSessionGenerationTransactItem: jest.fn().mockReturnValue({ Update: {} }),
    } as unknown as UsersRepository;
    const revoked = {
      tombstoneGenerationTransactItem: jest.fn().mockReturnValue({ Put: {} }),
    } as unknown as RevokedTokensRepository;
    const doc = {
      send: jest.fn().mockRejectedValue(transactCancel(['TransactionConflict', 'None'])),
    } as unknown as DynamoDBDocumentClient;
    const svc = new SessionRevocationService(
      doc,
      {} as RefreshTokensRepository,
      revoked,
      users,
      stubConfig(),
    );

    await expect(svc.revokeAll({ userId: USER_ID })).rejects.toMatchObject({
      response: { code: 'SESSION_REVOCATION_CONFLICT' },
    });
    // A transient reason is retried inside runTransactWrite (3 doc.send calls from one attempt) and never loops retireCurrentGeneration, so the User row is read once.
    expect(users.findByIdConsistent).toHaveBeenCalledTimes(1);
    expect(doc.send).toHaveBeenCalledTimes(3);
  });
});
