/**
 * Focused unit test for `RefreshTokensRepository.listAllForUser`'s pagination:
 * a user's refresh-token
 * partition can exceed DynamoDB's 1 MB `Query` response limit, at which point
 * DynamoDB returns a `LastEvaluatedKey` alongside a short `Items` page. The
 * old single-`Query` implementation silently returned only that first page —
 * both the account export's `refreshTokens` section and password-change's
 * revoke-all-sessions sweep would then miss the remaining rows. Stubs the
 * document client directly so
 * multi-page behavior is asserted at the boundary without needing to seed
 * enough real DynamoDB Local data to cross the 1 MB response threshold.
 */
import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';
import type { EnvConfig } from '../common/env.config.js';
import type { RefreshTokenRow } from './types.js';

const STUB_TABLE = 'test-refresh-token-table';

function makeStubRepo(
  send: (command: unknown) => Promise<unknown>,
): RefreshTokensRepository {
  const doc = { send } as unknown as DynamoDBDocumentClient;
  const config = { get: () => STUB_TABLE } as unknown as ConfigService<EnvConfig, true>;
  return new RefreshTokensRepository(doc, config);
}

describe('RefreshTokensRepository.listAllForUser — pagination', () => {
  it('loops on LastEvaluatedKey and returns every row across multiple pages, never just the first page', async () => {
    const userId = randomUUID();
    const pageOneKey = { userId, tokenHash: 'hash-1' };
    const pageTwoKey = { userId, tokenHash: 'hash-2' };
    const rows = [1, 2, 3].map((n) =>
      ({ userId, tokenHash: `hash-${n}` }) as RefreshTokenRow,
    );
    let calls = 0;
    const seenStartKeys: (Record<string, unknown> | undefined)[] = [];
    const repo = makeStubRepo(async (command) => {
      const input = (command as QueryCommand).input as {
        ExclusiveStartKey?: Record<string, unknown>;
      };
      seenStartKeys.push(input.ExclusiveStartKey);
      calls += 1;
      if (calls === 1) {
        return { Items: [rows[0]], LastEvaluatedKey: pageOneKey };
      }
      if (calls === 2) {
        return { Items: [rows[1]], LastEvaluatedKey: pageTwoKey };
      }
      return { Items: [rows[2]] };
    });

    const got = await repo.listAllForUser(userId);

    expect(calls).toBe(3);
    expect(seenStartKeys).toEqual([undefined, pageOneKey, pageTwoKey]);
    expect(got.map((r) => r.tokenHash).sort()).toEqual(
      ['hash-1', 'hash-2', 'hash-3'].sort(),
    );
  });

  it('makes a single call and returns its rows when the response fits in one page', async () => {
    const userId = randomUUID();
    const repo = makeStubRepo(async () => ({
      Items: [{ userId, tokenHash: 'only-hash' } as RefreshTokenRow],
    }));

    const got = await repo.listAllForUser(userId);

    expect(got).toEqual([{ userId, tokenHash: 'only-hash' }]);
  });
});

/**
 * `listFamily` pagination: a single-`Query` implementation
 * stopped after the first page, so a token family whose rows landed past a
 * partition-level page boundary (driven by the whole user's partition, not
 * the family's own size) was returned incomplete — reuse detection would
 * then revoke and denylist only part of a compromised family. Mirrors the
 * `listAllForUser` stubbed-client harness above.
 */
describe('RefreshTokensRepository.listFamily — pagination', () => {
  it('loops on LastEvaluatedKey and returns every family row across multiple pages', async () => {
    const userId = randomUUID();
    const tokenFamilyId = randomUUID();
    const pageOneKey = { userId, tokenHash: 'hash-1' };
    const pageTwoKey = { userId, tokenHash: 'hash-2' };
    const rows = [1, 2, 3].map(
      (n) => ({ userId, tokenHash: `hash-${n}`, tokenFamilyId }) as RefreshTokenRow,
    );
    let calls = 0;
    const seenStartKeys: (Record<string, unknown> | undefined)[] = [];
    const repo = makeStubRepo(async (command) => {
      const input = (command as QueryCommand).input as {
        ExclusiveStartKey?: Record<string, unknown>;
      };
      seenStartKeys.push(input.ExclusiveStartKey);
      calls += 1;
      if (calls === 1) {
        return { Items: [rows[0]], LastEvaluatedKey: pageOneKey };
      }
      if (calls === 2) {
        return { Items: [rows[1]], LastEvaluatedKey: pageTwoKey };
      }
      return { Items: [rows[2]] };
    });

    const got = await repo.listFamily(userId, tokenFamilyId);

    expect(calls).toBe(3);
    expect(seenStartKeys).toEqual([undefined, pageOneKey, pageTwoKey]);
    expect(got.map((r) => r.tokenHash).sort()).toEqual(
      ['hash-1', 'hash-2', 'hash-3'].sort(),
    );
  });

  it('keeps reading past pages whose filtered Items are empty but which carry a continuation key', async () => {
    // The reported reproduction: a single filtered Query returned [] for a
    // family that had members waiting on a later page. Two consecutive
    // empty-but-continuing pages, to prove the loop doesn't stop after one.
    const userId = randomUUID();
    const tokenFamilyId = randomUUID();
    const pageOneKey = { userId, tokenHash: 'other-1' };
    const pageTwoKey = { userId, tokenHash: 'other-2' };
    const member = { userId, tokenHash: 'member-1', tokenFamilyId } as RefreshTokenRow;
    let calls = 0;
    const repo = makeStubRepo(async () => {
      calls += 1;
      if (calls === 1) {
        return { Items: [], LastEvaluatedKey: pageOneKey };
      }
      if (calls === 2) {
        return { Items: [], LastEvaluatedKey: pageTwoKey };
      }
      return { Items: [member] };
    });

    const got = await repo.listFamily(userId, tokenFamilyId);

    expect(calls).toBe(3);
    expect(got).toEqual([member]);
  });

  it('makes a single call and returns its rows when the response fits in one page', async () => {
    const userId = randomUUID();
    const tokenFamilyId = randomUUID();
    let calls = 0;
    const repo = makeStubRepo(async () => {
      calls += 1;
      return {
        Items: [{ userId, tokenHash: 'only-hash', tokenFamilyId } as RefreshTokenRow],
      };
    });

    const got = await repo.listFamily(userId, tokenFamilyId);

    expect(calls).toBe(1);
    expect(got).toEqual([{ userId, tokenHash: 'only-hash', tokenFamilyId }]);
  });

  it('carries the family filter and family id on every request, not just the first', async () => {
    const userId = randomUUID();
    const tokenFamilyId = randomUUID();
    const pageOneKey = { userId, tokenHash: 'hash-1' };
    let calls = 0;
    const seenInputs: {
      FilterExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    }[] = [];
    const repo = makeStubRepo(async (command) => {
      const input = (command as QueryCommand).input as {
        FilterExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      seenInputs.push(input);
      calls += 1;
      if (calls === 1) {
        return {
          Items: [{ userId, tokenHash: 'hash-1', tokenFamilyId } as RefreshTokenRow],
          LastEvaluatedKey: pageOneKey,
        };
      }
      return {
        Items: [{ userId, tokenHash: 'hash-2', tokenFamilyId } as RefreshTokenRow],
      };
    });

    await repo.listFamily(userId, tokenFamilyId);

    expect(calls).toBe(2);
    for (const input of seenInputs) {
      expect(input.FilterExpression).toBe('tokenFamilyId = :f');
      expect(input.ExpressionAttributeValues).toMatchObject({ ':f': tokenFamilyId });
    }
  });
});

/**
 * `revokeFamily`: DynamoDB's
 * `TransactWriteItems` hard-caps at 100 items per call. `SessionRevocationService
 * .revokeAll` can pass every active refresh row for a user — well over 100 for
 * an account with many devices/rotations — so an unchunked single transaction
 * fails outright past that limit. Assert the chunking directly rather than
 * seeding 101 real rows through emulators.
 */
describe('RefreshTokensRepository.revokeFamily — chunking past the 100-item transaction limit', () => {
  function row(userId: string, n: number): RefreshTokenRow {
    return { userId, tokenHash: `hash-${n}` } as RefreshTokenRow;
  }

  it('sends a single transaction for 100 rows or fewer', async () => {
    const userId = randomUUID();
    const rows = Array.from({ length: 100 }, (_, i) => row(userId, i));
    const sent: TransactWriteCommand[] = [];
    const repo = makeStubRepo(async (command) => {
      sent.push(command as TransactWriteCommand);
      return {};
    });

    await repo.revokeFamily(rows, '2026-01-01T00:00:00.000Z');

    expect(sent).toHaveLength(1);
    expect(sent[0].input.TransactItems).toHaveLength(100);
  });

  it('splits 101 rows into two transactions, each within the 100-item limit', async () => {
    const userId = randomUUID();
    const rows = Array.from({ length: 101 }, (_, i) => row(userId, i));
    const sent: TransactWriteCommand[] = [];
    const repo = makeStubRepo(async (command) => {
      sent.push(command as TransactWriteCommand);
      return {};
    });

    await repo.revokeFamily(rows, '2026-01-01T00:00:00.000Z');

    expect(sent).toHaveLength(2);
    expect(sent[0].input.TransactItems).toHaveLength(100);
    expect(sent[1].input.TransactItems).toHaveLength(1);
    const allTokenHashes = sent.flatMap((cmd) =>
      (cmd.input.TransactItems ?? []).map((item) => item.Update?.Key?.tokenHash),
    );
    expect(new Set(allTokenHashes).size).toBe(101);
  });

  it('sends nothing for an empty row list', async () => {
    const sent: TransactWriteCommand[] = [];
    const repo = makeStubRepo(async (command) => {
      sent.push(command as TransactWriteCommand);
      return {};
    });

    await repo.revokeFamily([], '2026-01-01T00:00:00.000Z');

    expect(sent).toHaveLength(0);
  });
});
