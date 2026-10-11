/**
 * Cross-instance + opt-out guarantees for the shared request-throttle
 * counter.
 *
 * The cross-instance guarantee rests on DynamoDB's item-level atomicity, so
 * it is proved against the real emulator (`pnpm emu:up`) with TWO
 * INDEPENDENTLY bootstrapped app instances — separate `TestingModule`/DI
 * containers, each resolving its OWN `ThrottlerStorage` instance (the exact
 * object `ThrottlerGuard` calls in a running app, fetched via
 * `@nestjs/throttler`'s own `getStorageToken()`), sharing one table
 * namespace. A test that reused one DI container or one storage object
 * would prove nothing here — the old per-process `ThrottlerStorageService`
 * passed that degenerate shape too.
 *
 * The opt-out test runs against the shared harness's default
 * `DISABLE_THROTTLE=true` (jest.setup.ts) — unlike
 * `clear-workspace-throttle.spec.ts`, which is the one file that clears the
 * flag to prove throttling IS enforced, this file proves the opt-out
 * short-circuits BEFORE the guard ever touches storage.
 */
import { getStorageToken } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import { ThrottleCounterRepository } from '../dynamo/throttle-counter.repository.js';

describe('shared throttle counter storage — cross-instance', () => {
  let a: TestApp;
  let b: TestApp;
  let storageA: ThrottlerStorage;
  let storageB: ThrottlerStorage;

  beforeAll(async () => {
    // Two independently bootstrapped app instances — the real-world shape
    // of two Lambda instances sharing one table.
    a = await bootstrapTestApp();
    b = await bootstrapTestApp();
    storageA = a.module.get(getStorageToken());
    storageB = b.module.get(getStorageToken());
  });

  afterAll(async () => {
    await a.app.close();
    await b.app.close();
  });

  it('a hit on instance A is visible to instance B, and the total (not either instance\'s own count) trips the limit', async () => {
    const key = `wire-cross-${Date.now()}`;
    const limit = 3;
    const ttl = 60_000;

    const r1 = await storageA.increment(key, ttl, limit, ttl, 'default');
    expect(r1.totalHits).toBe(1);
    expect(r1.isBlocked).toBe(false);

    const r2 = await storageB.increment(key, ttl, limit, ttl, 'default');
    expect(r2.totalHits).toBe(2);
    expect(r2.isBlocked).toBe(false);

    const r3 = await storageA.increment(key, ttl, limit, ttl, 'default');
    expect(r3.totalHits).toBe(3);
    expect(r3.isBlocked).toBe(false);

    // The 4th hit, on the OTHER instance, is the one that trips the limit —
    // proving the count is the cross-instance total, not either object's
    // own view.
    const r4 = await storageB.increment(key, ttl, limit, ttl, 'default');
    expect(r4.totalHits).toBe(4);
    expect(r4.isBlocked).toBe(true);
  });
});

describe('shared throttle counter storage — opt-out', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Relies on the shared harness's default `DISABLE_THROTTLE=true`
    // (jest.setup.ts) — deliberately NOT flipped here.
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('DISABLE_THROTTLE=true costs zero store calls, not merely a 200 response', async () => {
    const spy = jest.spyOn(ThrottleCounterRepository.prototype, 'increment');

    for (let i = 0; i < 5; i += 1) {
      const res = await request(t.app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
    }

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
