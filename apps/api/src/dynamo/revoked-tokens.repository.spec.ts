// RevokedTokensRepository.isGenerationRevoked must read with ConsistentRead: true, which DynamoDB Local cannot prove (it never reproduces replica lag, so an emulator test passes if strong consistency is dropped);
// the document client is stubbed to assert the GetItem parameters.
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
      // An eventually consistent read could be served from a replica that has not received the tombstone just committed by the generation bump, letting a just-retired generation's token pass the guard for the length of the lag.
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
