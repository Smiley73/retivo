/**
 * Unit test for the refresh-token reuse incident log.
 *
 * The `RefreshTokenReuse` metric is now emitted as direct EMF from
 * AuthEventsRepository, so the reuse `logger.warn` is pure incident
 * context — not the old `refresh_token_reuse_detected` metric-filter marker.
 * This test pins that the incident warn is emitted on reuse (userId only) and
 * that the old marker string is gone — the integration suite (auth.spec.ts)
 * covers the wire behaviour; here we drive `rotate()` with a stubbed
 * repository returning an already-revoked row and assert the `logger.warn`
 * first arg.
 *
 * Pure unit test: every collaborator is a stub, so no DynamoDB Local /
 * Moto round trip is needed.
 */
import 'reflect-metadata';
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createHash } from 'node:crypto';
import type { EnvConfig } from '../common/env.config.js';
import { RefreshTokenService } from './refresh-token.service.js';
import type { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import type { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { RefreshTokenRow } from '../dynamo/types.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const USER_ID = 'user-123';
const PRESENTED_TOKEN = `${USER_ID}.cmFuZG9tLXN1ZmZpeA`;
const NEW_ACCESS_JTI = 'new-access-jti';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function revokedRow(): RefreshTokenRow {
  return {
    userId: USER_ID,
    tokenHash: sha256(PRESENTED_TOKEN),
    tokenFamilyId: 'family-1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    revokedAt: new Date().toISOString(), // already revoked → reuse path
    rotatedFrom: null,
    userAgent: null,
    ip: null,
    jti: 'jti-1',
    deviceId: 'device-1',
    householdId: USER_ID,
    createdAt: new Date().toISOString(),
    sessionGeneration: 0,
  };
}

function stubConfig(): TypedConfig {
  return {
    get: jest.fn((key: string) =>
      key === 'AUTH_REFRESH_TOKEN_TTL_MIN' ? 60 : 'revoked-token-table',
    ),
  } as unknown as TypedConfig;
}

/** Mirrors `dynamo/transact-write.spec.ts`'s crafted-cancellation helper —
 *  the local DynamoDB emulator cannot deterministically produce a
 *  `TransactionConflict` cancellation. */
function transactCancel(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled, please refer to CancellationReasons',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function buildService(row: RefreshTokenRow): RefreshTokenService {
  const refreshTokens = {
    find: jest.fn().mockResolvedValue(row),
    listFamily: jest.fn().mockResolvedValue([row]),
    revokeFamily: jest.fn().mockResolvedValue(undefined),
  } as unknown as RefreshTokensRepository;
  const revokedTokens = {
    putFamilyBarrier: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(undefined),
  } as unknown as RevokedTokensRepository;
  const users = {} as UsersRepository;
  const auth = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthEventsRepository;
  const doc = { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;

  return new RefreshTokenService(doc, refreshTokens, revokedTokens, users, auth, stubConfig());
}

describe('RefreshTokenService — reuse detection log', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits an incident-context reuse warn (userId only), not the old metric marker', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = buildService(revokedRow());

    await expect(service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // The RefreshTokenReuse metric is now direct EMF; the log is
    // incident context, not the `refresh_token_reuse_detected` filter marker.
    expect(warnSpy).toHaveBeenCalledWith('Refresh token reuse detected', {
      userId: USER_ID,
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      'refresh_token_reuse_detected',
      expect.anything(),
    );
  });

  it('plants the family barrier BEFORE enumerating the family with a consistent read', async () => {
    const row = revokedRow();
    const calls: string[] = [];
    const refreshTokens = {
      find: jest.fn().mockResolvedValue(row),
      listFamily: jest.fn().mockImplementation(async (_u, _f, opts) => {
        calls.push('listFamily');
        expect(opts).toEqual({ consistentRead: true });
        return [row];
      }),
      revokeFamily: jest.fn().mockResolvedValue(undefined),
    } as unknown as RefreshTokensRepository;
    const revokedTokens = {
      putFamilyBarrier: jest.fn().mockImplementation(async () => {
        calls.push('putFamilyBarrier');
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    } as unknown as RevokedTokensRepository;
    const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
    const doc = { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const service = new RefreshTokenService(
      doc,
      refreshTokens,
      revokedTokens,
      {} as UsersRepository,
      auth,
      stubConfig(),
    );

    await expect(service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(calls).toEqual(['putFamilyBarrier', 'listFamily']);
  });

  it('rejects a legacy row with no stamped sessionGeneration before ever reaching reuse detection (cutover)', async () => {
    const legacyRow: RefreshTokenRow = { ...revokedRow(), sessionGeneration: undefined };
    const refreshTokens = {
      find: jest.fn().mockResolvedValue(legacyRow),
      listFamily: jest.fn(),
      revokeFamily: jest.fn(),
    } as unknown as RefreshTokensRepository;
    const revokedTokens = { putFamilyBarrier: jest.fn() } as unknown as RevokedTokensRepository;
    const auth = { record: jest.fn() } as unknown as AuthEventsRepository;
    const doc = { send: jest.fn() } as unknown as DynamoDBDocumentClient;
    const service = new RefreshTokenService(
      doc,
      refreshTokens,
      revokedTokens,
      {} as UsersRepository,
      auth,
      stubConfig(),
    );

    await expect(service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI)).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    expect(refreshTokens.listFamily).not.toHaveBeenCalled();
    expect(revokedTokens.putFamilyBarrier).not.toHaveBeenCalled();
  });

  it('does not emit the reuse warn on a valid (non-revoked) rotation', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const validRow: RefreshTokenRow = { ...revokedRow(), revokedAt: null };
    const refreshTokens = {
      find: jest.fn().mockResolvedValue(validRow),
      insertTransactItem: jest.fn().mockReturnValue({ Put: {} }),
      revokeTransactItem: jest.fn().mockReturnValue({ Update: {} }),
    } as unknown as RefreshTokensRepository;
    const users = {
      conditionCheckSessionGenerationTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as UsersRepository;
    const revokedTokens = {
      conditionCheckNoFamilyBarrierTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as RevokedTokensRepository;
    const auth = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthEventsRepository;
    const doc = { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const service = new RefreshTokenService(
      doc,
      refreshTokens,
      revokedTokens,
      users,
      auth,
      stubConfig(),
    );

    await service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI);

    expect(warnSpy).not.toHaveBeenCalledWith(
      'Refresh token reuse detected',
      expect.anything(),
    );
  });

  it('carries the predecessor row\'s sessionGeneration forward verbatim onto the rotated row', async () => {
    const validRow: RefreshTokenRow = { ...revokedRow(), revokedAt: null, sessionGeneration: 7 };
    let insertedRow: RefreshTokenRow | undefined;
    const refreshTokens = {
      find: jest.fn().mockResolvedValue(validRow),
      insertTransactItem: jest.fn().mockImplementation((row: RefreshTokenRow) => {
        insertedRow = row;
        return { Put: {} };
      }),
      revokeTransactItem: jest.fn().mockReturnValue({ Update: {} }),
    } as unknown as RefreshTokensRepository;
    const users = {
      conditionCheckSessionGenerationTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as UsersRepository;
    const revokedTokens = {
      conditionCheckNoFamilyBarrierTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as RevokedTokensRepository;
    const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
    const doc = { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const service = new RefreshTokenService(
      doc,
      refreshTokens,
      revokedTokens,
      users,
      auth,
      stubConfig(),
    );

    await service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI);

    expect(insertedRow?.sessionGeneration).toBe(7);
    expect(users.conditionCheckSessionGenerationTransactItem).toHaveBeenCalledWith(
      USER_ID,
      7,
    );
  });

  it('surfaces a 503 REFRESH_TOKEN_CONFLICT — not a 500 — when the issuance transaction is cancelled for a transient reason', async () => {
    const validRow: RefreshTokenRow = { ...revokedRow(), revokedAt: null };
    const refreshTokens = {
      find: jest.fn().mockResolvedValue(validRow),
      insertTransactItem: jest.fn().mockReturnValue({ Put: {} }),
      revokeTransactItem: jest.fn().mockReturnValue({ Update: {} }),
    } as unknown as RefreshTokensRepository;
    const users = {
      conditionCheckSessionGenerationTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as UsersRepository;
    const revokedTokens = {
      conditionCheckNoFamilyBarrierTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
    } as unknown as RevokedTokensRepository;
    const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
    const doc = {
      send: jest.fn().mockRejectedValue(
        transactCancel(['TransactionConflict', 'None', 'None', 'None']),
      ),
    } as unknown as DynamoDBDocumentClient;
    const service = new RefreshTokenService(
      doc,
      refreshTokens,
      revokedTokens,
      users,
      auth,
      stubConfig(),
    );

    await expect(service.rotate(PRESENTED_TOKEN, NEW_ACCESS_JTI)).rejects.toMatchObject({
      response: { code: 'REFRESH_TOKEN_CONFLICT' },
    });
    // The presented row's revoke is item 3 of the SAME transaction as the
    // descendant's Put — a transient
    // cancellation of that shared transaction must not leave it revoked with
    // no successor, so `markRevoked`/`revokeTransactItem` is never committed
    // standalone here; only `runTransactWrite`'s own bounded retry (3
    // attempts) touches `doc.send`.
    expect(doc.send).toHaveBeenCalledTimes(3);
  });
});
