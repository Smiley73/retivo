// Cross-instance, single-use and expiry guarantees of the shared passkey challenge storage, which rest on DynamoDB's item-level atomicity, so they run against the emulator with two independently
// bootstrapped app instances (separate DI containers and stores over one table namespace). A test reusing one container or store would prove nothing; the old in-memory store passed that shape.
import { randomUUID } from 'node:crypto';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import { PasskeyChallengeStore } from '../auth/passkey-challenge-store.js';
import { PasskeyChallengeRepository } from '../dynamo/passkey-challenge.repository.js';

describe('shared passkey challenge storage — cross-instance + single-use', () => {
  let a: TestApp;
  let b: TestApp;
  let storeA: PasskeyChallengeStore;
  let storeB: PasskeyChallengeStore;

  beforeAll(async () => {
    // Two Lambda instances sharing one table.
    a = await bootstrapTestApp();
    b = await bootstrapTestApp();
    storeA = a.module.get(PasskeyChallengeStore);
    storeB = b.module.get(PasskeyChallengeStore);
  });

  afterAll(async () => {
    await a.app.close();
    await b.app.close();
  });

  it('a challenge issued on instance A is consumable on instance B, and a sequential replay on either instance is then refused', async () => {
    const key = `reg:${randomUUID()}`;
    await storeA.set(key, 'challenge-cross-instance', 'user-a');

    await expect(storeB.consume(key)).resolves.toEqual({
      challenge: 'challenge-cross-instance',
      userId: 'user-a',
    });
    await expect(storeA.consume(key)).resolves.toBeNull();
    await expect(storeB.consume(key)).resolves.toBeNull();
  });

  it('a concurrent consume from two instances has exactly one winner', async () => {
    const key = `auth:${randomUUID()}`;
    await storeA.set(key, 'challenge-concurrent');

    const [ra, rb] = await Promise.all([storeA.consume(key), storeB.consume(key)]);
    const winners = [ra, rb].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ challenge: 'challenge-concurrent', userId: undefined });
  });

  it('an elapsed row is refused even though nothing has deleted it — reader-enforced expiry, not DynamoDB TTL', async () => {
    const key = `auth:${randomUUID()}`;
    const repo = a.module.get(PasskeyChallengeRepository);
    // Written at the repository layer with an already-elapsed expiresAt: the emulator never sweeps TTL, so a TTL-only implementation would pass every other test here and still return this row.
    await repo.issue({
      key,
      challenge: 'challenge-expired',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(storeB.consume(key)).resolves.toBeNull();
  });

  it('`set` writes `expiresAt` in epoch SECONDS, 5 minutes out — the unit `consume` compares against and the table TTL attribute reads', async () => {
    const key = `reg:${randomUUID()}`;
    const repo = a.module.get(PasskeyChallengeRepository);
    const before = Math.floor(Date.now() / 1000);
    await storeA.set(key, 'challenge-units', 'user-c');
    const after = Math.floor(Date.now() / 1000);

    // Reading the raw row at the repository layer asserts the value `set` stored; with the `/ 1000` dropped it would land ~1000x further out and miss these bounds.
    const row = await repo.consume(key);
    expect(row).not.toBeNull();
    expect(row?.expiresAt).toBeGreaterThanOrEqual(before + 300);
    expect(row?.expiresAt).toBeLessThanOrEqual(after + 300);
  });

  it('a `set`-issued challenge is refused by `consume` once its 5-minute window has elapsed (set -> consume unit contract, end to end)', async () => {
    const key = `reg:${randomUUID()}`;
    await storeA.set(key, 'challenge-elapsed', 'user-d');

    // Only the reader's Date.now moves 5 min + 1 s forward, so `consume` is exercised against the exact `expiresAt` `set` produced, not a hand-built one.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1000);
    try {
      await expect(storeB.consume(key)).resolves.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('starting the same ceremony twice leaves the second challenge live and the first dead (issue overwrites)', async () => {
    const key = `reg:${randomUUID()}`;
    await storeA.set(key, 'challenge-first', 'user-b');
    await storeA.set(key, 'challenge-second', 'user-b');

    await expect(storeB.consume(key)).resolves.toEqual({
      challenge: 'challenge-second',
      userId: 'user-b',
    });
  });
});
