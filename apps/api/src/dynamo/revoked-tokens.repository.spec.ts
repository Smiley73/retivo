/**
 * Focused unit test for `RevokedTokensRepository.isGenerationRevoked` — the
 * strongly-consistent generation-tombstone read.
 *
 * The load-bearing `ConsistentRead: true` cannot be proven against DynamoDB
 * Local: the emulator never reproduces replica lag, so an emulator-backed
 * test still passes if strong consistency is silently dropped — production
 * could then briefly trust a just-retired generation. Stubs the
 * document client directly so the GetItem parameters are asserted at the boundary.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import { RevokedTokensRepository } from './revoked-tokens.repository.js';
import type { EnvConfig } from '../common/env.config.js';

const TABLE = 'test-revoked-token-table';

function makeRepo(
  send: (command: unknown) => Promise<unknown>,
): RevokedTokensRepository {
  const doc = { send } as unknown as DynamoDBDocumentClient;
  const config = { get: () => TABLE } as unknown as ConfigService<EnvConfig, true>;
  return new RevokedTokensRepository(doc, config);
}

describe('RevokedTokensRepository.isGenerationRevoked', () => {
  it('sends a strongly-consistent single-key GetItem', async () => {
    let sent: GetCommand | undefined;
    const repo = makeRepo(async (command) => {
      sent = command as GetCommand;
      return {};
    });

    await repo.isGenerationRevoked('user-1', 0);

    expect(sent).toBeInstanceOf(GetCommand);
    expect(sent?.input).toEqual({
      TableName: TABLE,
      Key: { jti: 'gen:user-1:0' },
      // Regression guard: the default eventually-consistent read
      // can be served from a replica that has not yet received the tombstone
      // this call is checking for, immediately after the generation-bump
      // transaction commits it — letting a just-retired generation's access
      // token pass the guard for the length of that replica lag.
      ConsistentRead: true,
    });
  });

  it('returns true when the tombstone item exists', async () => {
    const repo = makeRepo(async () => ({ Item: { jti: 'gen:user-1:0' } }));
    expect(await repo.isGenerationRevoked('user-1', 0)).toBe(true);
  });

  it('returns false when no tombstone item exists', async () => {
    const repo = makeRepo(async () => ({}));
    expect(await repo.isGenerationRevoked('user-1', 0)).toBe(false);
  });
});
