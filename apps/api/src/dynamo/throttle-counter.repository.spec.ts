/**
 * Integration tests for `ThrottleCounterRepository` against DynamoDB Local.
 * Covers the increment contract at the
 * repository layer:
 *  - a fresh key starts a one-hit window;
 *  - hits accumulate within a still-open window;
 *  - a window whose stored expiry has already passed resets to one hit
 *    rather than continuing the stale count, even though the emulator never
 *    TTL-sweeps the row away;
 *  - concurrent increments on one key total exactly the number issued (no
 *    lost updates).
 *
 * The cross-instance guarantee (two independently constructed repository
 * objects sharing one table) lives in
 * `../test/shared-throttle-counters.spec.ts` — this file covers one
 * repository object's own contract in isolation.
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import { ThrottleCounterRepository } from './throttle-counter.repository.js';

describe('ThrottleCounterRepository', () => {
  let t: TestApp;
  let repo: ThrottleCounterRepository;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    repo = t.module.get(ThrottleCounterRepository);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('starts a fresh key at one hit, with a window ending ~windowMs out', async () => {
    const key = randomUUID();
    const before = Date.now();
    const result = await repo.increment(key, 60_000, new AbortController().signal);
    const after = Date.now();

    expect(result.hits).toBe(1);
    expect(result.windowEndMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(result.windowEndMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('accumulates hits within a still-open window', async () => {
    const key = randomUUID();
    await repo.increment(key, 60_000, new AbortController().signal);
    await repo.increment(key, 60_000, new AbortController().signal);
    const third = await repo.increment(key, 60_000, new AbortController().signal);

    expect(third.hits).toBe(3);
  });

  it('resets to one hit once the stored window has ended, even though the row is still present', async () => {
    const key = randomUUID();
    const first = await repo.increment(key, 50, new AbortController().signal);
    expect(first.hits).toBe(1);

    // The emulator never TTL-sweeps — the row is still there. Waiting past
    // the tiny window proves the reset is read from `windowEnd`, not from
    // the row's absence.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await repo.increment(key, 60_000, new AbortController().signal);
    expect(second.hits).toBe(1);
    expect(second.windowEndMs).toBeGreaterThan(first.windowEndMs);
  });

  it('concurrent increments on one key total exactly the number issued (no lost updates)', async () => {
    const key = randomUUID();
    const CONCURRENCY = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        repo.increment(key, 60_000, new AbortController().signal),
      ),
    );

    const hits = results.map((r) => r.hits).sort((a, b) => a - b);
    expect(hits).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  });

  it('rejects when the abort signal has already fired', async () => {
    const key = randomUUID();
    const controller = new AbortController();
    controller.abort();

    await expect(repo.increment(key, 60_000, controller.signal)).rejects.toBeTruthy();
  });
});
