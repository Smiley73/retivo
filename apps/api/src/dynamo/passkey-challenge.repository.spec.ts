/**
 * Integration tests for `PasskeyChallengeRepository` against DynamoDB Local.
 * Covers the issue/consume contract at
 * the repository layer:
 *  - consume on a missing key returns null;
 *  - issue + consume round-trips the row and single-use-consumes it (a
 *    second consume of the same key returns null);
 *  - issue overwrites an existing row under the same key.
 *
 * The cross-instance / concurrent-consume / reader-enforced-expiry
 * GUARANTEES live in `../test/passkey-challenge-store.spec.ts` — this file
 * covers the repository's own contract in isolation.
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import { PasskeyChallengeRepository } from './passkey-challenge.repository.js';

describe('PasskeyChallengeRepository', () => {
  let t: TestApp;
  let repo: PasskeyChallengeRepository;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    repo = t.module.get(PasskeyChallengeRepository);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('returns null consuming a key that was never issued', async () => {
    expect(await repo.consume(`reg:${randomUUID()}`)).toBeNull();
  });

  it('round-trips a row through issue + consume, and single-use consumes it', async () => {
    const key = `reg:${randomUUID()}`;
    const row = {
      key,
      challenge: 'a-challenge',
      userId: 'user-1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
    await repo.issue(row);

    expect(await repo.consume(key)).toEqual(row);
    // Single-use: the same key is gone the second time.
    expect(await repo.consume(key)).toBeNull();
  });

  it('issue overwrites an existing row at the same key (re-issue, not append)', async () => {
    const key = `auth:${randomUUID()}`;
    await repo.issue({ key, challenge: 'first', expiresAt: Math.floor(Date.now() / 1000) + 300 });
    await repo.issue({ key, challenge: 'second', expiresAt: Math.floor(Date.now() / 1000) + 300 });

    const consumed = await repo.consume(key);
    expect(consumed?.challenge).toBe('second');
  });

  it('a row with no userId (the discoverable-login `auth:` namespace) round-trips with userId absent', async () => {
    const key = `auth:${randomUUID()}`;
    await repo.issue({ key, challenge: 'anon', expiresAt: Math.floor(Date.now() / 1000) + 300 });

    const consumed = await repo.consume(key);
    expect(consumed).toEqual({ key, challenge: 'anon', expiresAt: expect.any(Number) });
    expect(consumed).not.toHaveProperty('userId');
  });
});
