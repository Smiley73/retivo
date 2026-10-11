/**
 * Cross-instance / single-use / expiry guarantees for the shared passkey
 * challenge storage.
 *
 * These guarantees rest on DynamoDB's item-level atomicity, so they are
 * proved against the real emulator (`pnpm emu:up`) with TWO INDEPENDENTLY
 * bootstrapped app instances — separate `TestingModule`/DI containers, each
 * with its own `PasskeyChallengeStore` object, sharing one table namespace
 * (the per-worker jest namespace both instances inherit from the same
 * process env). A test that reused one DI container or one
 * `PasskeyChallengeStore` object would prove nothing here — the old
 * in-memory store passed that degenerate shape too.
 */
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
    // Two independently bootstrapped app instances — the real-world shape
    // of two Lambda instances sharing one table.
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
    // Replay: neither instance can consume it again.
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
    // Write directly at the repository layer with an already-elapsed
    // expiresAt — the emulator never sweeps TTL, so a TTL-only
    // implementation would pass every other test in this file and still
    // wrongly return this row.
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

    // Read the raw row back at the repository layer (not through the store)
    // so the assertion is on the value `set` actually stored, before the
    // store's own reader-side check interprets it. `set` with the `/ 1000`
    // dropped would land ~1000x further out and miss these bounds.
    const row = await repo.consume(key);
    expect(row).not.toBeNull();
    expect(row?.expiresAt).toBeGreaterThanOrEqual(before + 300);
    expect(row?.expiresAt).toBeLessThanOrEqual(after + 300);
  });

  it('a `set`-issued challenge is refused by `consume` once its 5-minute window has elapsed (set -> consume unit contract, end to end)', async () => {
    const key = `reg:${randomUUID()}`;
    await storeA.set(key, 'challenge-elapsed', 'user-d');

    // The row was written with the real clock; only the reader's `Date.now`
    // is moved 5 min + 1 s forward (same shape as lockout-scoping.spec.ts),
    // so `consume` is exercised against the exact `expiresAt` `set`
    // produced — not a hand-built one as in the repository-level case above.
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
