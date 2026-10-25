// bumpFreshnessHead's degenerate fallback with a stubbed document client: when the conditional UpdateItem fails and the fallback GetItem finds no stored head, it must return null, not a fabricated
// { storedCounter: 0, storedTag: '' }, which can never pass the client's MAC verification and would surface a false rollback on a successful push.
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { EnvConfig } from '../common/env.config.js';

function makeRepo(
  send: (command: unknown) => Promise<unknown>,
): WorkspaceMetaRepository {
  const doc = { send } as unknown as DynamoDBDocumentClient;
  const config = {
    get: () => 'test-workspace-meta-table',
  } as unknown as ConfigService<EnvConfig, true>;
  return new WorkspaceMetaRepository(doc, config);
}

describe('WorkspaceMetaRepository.bumpFreshnessHead — degenerate fallback', () => {
  it('returns null (not a fabricated empty head) when the update fails and no stored head is readable', async () => {
    const send = async (command: unknown): Promise<unknown> => {
      if (command instanceof UpdateCommand) {
        const err = new Error('conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      if (command instanceof GetCommand) {
        return { Item: { householdId: 'hh-1' } };
      }
      throw new Error('unexpected command');
    };
    const repo = makeRepo(send);

    const result = await repo.bumpFreshnessHead('hh-1', 'dev-1', 5, 'some-tag');
    expect(result).toBeNull();
  });

  it('still echoes the stored head when the fallback read finds one (no regression)', async () => {
    const send = async (command: unknown): Promise<unknown> => {
      if (command instanceof UpdateCommand) {
        const err = new Error('conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      if (command instanceof GetCommand) {
        return { Item: { householdId: 'hh-1', freshnessCounter: 9, cursorTag: 'tag-9' } };
      }
      throw new Error('unexpected command');
    };
    const repo = makeRepo(send);

    const result = await repo.bumpFreshnessHead('hh-1', 'dev-1', 5, 'some-tag');
    expect(result).toEqual({ storedCounter: 9, storedTag: 'tag-9' });
  });

  it('returns null when both the update and the fallback read fail', async () => {
    const send = async (command: unknown): Promise<unknown> => {
      if (command instanceof UpdateCommand) {
        throw new Error('transient dynamo fault');
      }
      if (command instanceof GetCommand) {
        throw new Error('transient dynamo fault on read too');
      }
      throw new Error('unexpected command');
    };
    const repo = makeRepo(send);

    const result = await repo.bumpFreshnessHead('hh-1', 'dev-1', 5, 'some-tag');
    expect(result).toBeNull();
  });
});
