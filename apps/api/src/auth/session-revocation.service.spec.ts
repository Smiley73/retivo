/**
 * Unit tests for `SessionRevocationService.revokeAll`'s generation boundary.
 *
 * The integration suite (session-revocation-generation.spec.ts) only covers
 * the correctly-ordered cascade — the account row still exists and the
 * generation bump lands cleanly. These unit tests instead drive
 * `retireCurrentGeneration`'s two failure branches directly with a stubbed
 * `UsersRepository` / document client, mirroring
 * `dynamo/transact-write.spec.ts`'s crafted-`TransactionCanceledException`
 * approach (the local DynamoDB emulator cannot deterministically produce a
 * losing condition or a transient conflict):
 *
 *   (a) the `User` row is already gone → fails closed, no bump/tombstone Put
 *       is ever attempted;
 *   (b) the generation bump's own `ConditionCheck` loses on every bounded
 *       retry attempt → `503 SESSION_REVOCATION_CONFLICT`;
 *   (c) a transient cancellation survives `runTransactWrite`'s own bounded
 *       retry → the SAME `503 SESSION_REVOCATION_CONFLICT`, not a 500.
 */
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
    // One `findByIdConsistent` + one `doc.send` per bounded-retry attempt — a
    // losing ConditionCheck re-reads and retries rather than failing on the
    // first loss (a concurrent revocation already achieved this call's goal).
    // A strongly consistent re-read is used here specifically because the
    // retry re-reads immediately after another writer's own commit to this
    // item — the window where a plain replica read is likely stale.
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
    // A transient reason is retried entirely INSIDE `runTransactWrite`'s own
    // bounded retry (3 `doc.send` calls from ONE `retireCurrentGeneration`
    // attempt) — it never loops `retireCurrentGeneration` itself again, so
    // `findByIdConsistent` is read only once.
    expect(users.findByIdConsistent).toHaveBeenCalledTimes(1);
    expect(doc.send).toHaveBeenCalledTimes(3);
  });
});
