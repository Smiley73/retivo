// PasskeyChallengeRepository's issue/consume contract on DynamoDB Local: a missing key consumes to null, issue then consume round-trips and is single-use, and issue overwrites an existing row.
// The cross-instance, concurrent-consume and expiry guarantees live in passkey-challenge-store.spec.ts.
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
