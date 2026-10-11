/**
 * Integration tests for `PasskeysRepository.updateCounterAndLastUsed` — the
 * zero-counter-preserving conditional write that closes the signature-counter
 * TOCTOU on both passkey paths. Run against
 * DynamoDB Local.
 *
 * The condition is `attribute_not_exists(#counter) OR #counter = :zero OR
 * #counter < :counter` (`:counter` is the presented value; the zero-exception
 * keys on the STORED `#counter`):
 *  - the first write after enrollment is allowed,
 *  - a zero-counter authenticator (stored 0 → presented 0) still updates
 *    `lastUsedAt` (the majority of platform/synced passkeys report counter 0
 *    forever — must not break sign-in),
 *  - a monotonic advance on a counter-using authenticator is allowed,
 *  - a regression / lost update (stored > 0, presented ≤ stored, including a
 *    presented-0 rollback) is rejected.
 *
 * Fresh userIds/credentialIds per case keep the suite independent on the shared
 * DynamoDB Local instance.
 */
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import { createRepoTestEnv, type RepoTestEnv } from '../test/test-helpers.js';
import { PasskeysRepository } from './passkeys.repository.js';
import type { EnvConfig } from '../common/env.config.js';
import type { PasskeyRow } from './types.js';

const STUB_TABLE = 'test-passkey-table';

function makeStubRepo(
  send: (command: unknown) => Promise<unknown>,
): PasskeysRepository {
  const doc = { send } as unknown as DynamoDBDocumentClient;
  const config = { get: () => STUB_TABLE } as unknown as ConfigService<EnvConfig, true>;
  return new PasskeysRepository(doc, config);
}

function row(userId: string, credentialId: string, counter: number): PasskeyRow {
  return {
    userId,
    credentialId,
    publicKey: 'cGs',
    counter,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: '2026-06-14T00:00:00.000Z',
    lastUsedAt: null,
  };
}

describe('PasskeysRepository.updateCounterAndLastUsed — conditional write', () => {
  let env: RepoTestEnv;
  let repo: PasskeysRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new PasskeysRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  it('allows the first write after enrollment', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 0));
    await repo.updateCounterAndLastUsed(userId, credentialId, 1, '2026-06-14T01:00:00.000Z');
    const got = await repo.find(userId, credentialId);
    expect(got?.counter).toBe(1);
    expect(got?.lastUsedAt).toBe('2026-06-14T01:00:00.000Z');
  });

  it('allows a zero-counter authenticator (stored 0 → presented 0) and updates lastUsedAt', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 0));
    // First sign-in: 0 → 0 must succeed (most platform passkeys never advance).
    await repo.updateCounterAndLastUsed(userId, credentialId, 0, '2026-06-14T02:00:00.000Z');
    let got = await repo.find(userId, credentialId);
    expect(got?.counter).toBe(0);
    expect(got?.lastUsedAt).toBe('2026-06-14T02:00:00.000Z');
    // A subsequent 0 → 0 sign-in must also succeed (regression test for existing
    // zero-counter sign-in).
    await repo.updateCounterAndLastUsed(userId, credentialId, 0, '2026-06-14T03:00:00.000Z');
    got = await repo.find(userId, credentialId);
    expect(got?.lastUsedAt).toBe('2026-06-14T03:00:00.000Z');
  });

  it('allows a monotonic advance on a counter-using authenticator', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 5));
    await repo.updateCounterAndLastUsed(userId, credentialId, 6, '2026-06-14T04:00:00.000Z');
    const got = await repo.find(userId, credentialId);
    expect(got?.counter).toBe(6);
  });

  it('rejects a regression / lost update on a counter-using authenticator (stored > 0, presented ≤ stored)', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 9));
    // presented < stored — a possible cloned-credential signal.
    await expect(
      repo.updateCounterAndLastUsed(userId, credentialId, 4, '2026-06-14T05:00:00.000Z'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    // presented === stored on a non-zero counter — a lost update, also rejected.
    await expect(
      repo.updateCounterAndLastUsed(userId, credentialId, 9, '2026-06-14T05:00:00.000Z'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    // The stored counter is unchanged.
    const got = await repo.find(userId, credentialId);
    expect(got?.counter).toBe(9);
  });

  it('rejects a presented-0 rollback against a stored non-zero counter (zero-exception keys on STORED counter)', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 9));
    // stored 9 / presented 0: the zero-exception must key on the STORED counter,
    // not the presented value — otherwise a presented-0 assertion would roll the
    // stored counter back to 0 at the DB layer and defeat clone detection.
    await expect(
      repo.updateCounterAndLastUsed(userId, credentialId, 0, '2026-06-14T06:00:00.000Z'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    // The stored counter is unchanged — no rollback occurred.
    const got = await repo.find(userId, credentialId);
    expect(got?.counter).toBe(9);
  });
});

describe('PasskeysRepository.remove — reports whether a row actually existed', () => {
  let env: RepoTestEnv;
  let repo: PasskeysRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new PasskeysRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  it('returns true and deletes the row for a credential that exists', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();
    await repo.insert(row(userId, credentialId, 0));

    expect(await repo.remove(userId, credentialId)).toBe(true);
    expect(await repo.find(userId, credentialId)).toBeNull();
  });

  it('returns false (still a no-op success) for an unknown/already-removed credential', async () => {
    const userId = randomUUID();
    const credentialId = randomUUID();

    expect(await repo.remove(userId, credentialId)).toBe(false);
  });
});

describe('PasskeysRepository.listForUser — pagination', () => {
  it('loops on LastEvaluatedKey and returns every row across multiple pages, never just the first page', async () => {
    const userId = randomUUID();
    const pageOneKey = { userId, credentialId: 'cred-1' };
    const rows = [1, 2, 3].map((n) =>
      ({ userId, credentialId: `cred-${n}` }) as PasskeyRow,
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
        // First page reports only one row and a LastEvaluatedKey — the shape
        // DynamoDB returns when the 1 MB response-size limit truncates a
        // partition, not when the partition is actually exhausted.
        return { Items: [rows[0]], LastEvaluatedKey: pageOneKey };
      }
      // Second (final) page: the rest, no LastEvaluatedKey.
      return { Items: [rows[1], rows[2]] };
    });

    const got = await repo.listForUser(userId);

    expect(calls).toBe(2);
    expect(seenStartKeys).toEqual([undefined, pageOneKey]);
    expect(got.map((r) => r.credentialId).sort()).toEqual(
      ['cred-1', 'cred-2', 'cred-3'].sort(),
    );
  });
});
