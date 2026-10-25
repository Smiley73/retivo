// DynamoThrottlerStorage's failure policy with the repository stubbed: the store succeeding, the deadline firing on a slow store, a throwing store, the fallback being bounded rather than an open door,
// the once-per-episode warning and metric (also across a flapping failure pattern), and nothing logged carrying the throttle key or tracker.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import fs from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { DynamoThrottlerStorage } from './dynamo-throttler-storage.js';
import type { EnvConfig } from '../common/env.config.js';
import type { ThrottleCounterRepository } from '../dynamo/throttle-counter.repository.js';

function configFor(stack: string): ConfigService<EnvConfig, true> {
  return { get: () => stack } as unknown as ConfigService<EnvConfig, true>;
}

function captureMetricNames(): { names: string[]; restore: () => void } {
  const names: string[] = [];
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd !== 1) {
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }
    try {
      const parsed = JSON.parse(String(data)) as {
        _aws?: { CloudWatchMetrics: { Metrics: { Name: string }[] }[] };
      };
      if (parsed._aws) names.push(parsed._aws.CloudWatchMetrics[0].Metrics[0].Name);
    } catch {
    }
    return Buffer.byteLength(String(data));
  }) as unknown as typeof fs.writeSync);
  return { names, restore: () => spy.mockRestore() };
}

describe('DynamoThrottlerStorage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a record derived from the repository result on success, never touching the fallback', async () => {
    const repo = {
      increment: jest.fn().mockResolvedValue({
        hits: 3,
        windowEndMs: Date.now() + 10_000,
      }),
    } as unknown as ThrottleCounterRepository;
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    const record = await storage.increment('key-a', 60_000, 5, 60_000, 'default');

    expect(record.totalHits).toBe(3);
    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
    expect(record.timeToExpire).toBeGreaterThan(0);
  });

  it('marks the record blocked once hits exceed the limit, with a matching block-expiry', async () => {
    const windowEndMs = Date.now() + 10_000;
    const repo = {
      increment: jest.fn().mockResolvedValue({ hits: 6, windowEndMs }),
    } as unknown as ThrottleCounterRepository;
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    const record = await storage.increment('key-b', 60_000, 5, 60_000, 'default');

    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(record.timeToExpire);
    expect(record.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('degrades to the bounded in-memory fallback when the store rejects, still succeeding the request', async () => {
    const repo = {
      increment: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')),
    } as unknown as ThrottleCounterRepository;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    const record = await storage.increment('key-c', 60_000, 5, 60_000, 'default');

    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('degrades to the bounded in-memory fallback when the store hangs past the deadline', async () => {
    jest.useFakeTimers();
    try {
      const repo = {
        increment: jest.fn().mockImplementation(() => new Promise(() => {})),
      } as unknown as ThrottleCounterRepository;
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

      const pending = storage.increment('key-d', 60_000, 5, 60_000, 'default');
      await jest.advanceTimersByTimeAsync(1_000);
      const record = await pending;

      expect(record.totalHits).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the fallback stays bounded across repeated failures — a busy key still blocks once the local limit is crossed', async () => {
    const repo = {
      increment: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as ThrottleCounterRepository;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await storage.increment('key-e', 60_000, 5, 60_000, 'default');
    }

    expect(last!.isBlocked).toBe(true);
  });

  it('warns and emits the allow-listed metric exactly once per degradation episode, and an intermittent success does not end the episode', async () => {
    const repo = {
      increment: jest
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('still down'))
        .mockResolvedValueOnce({ hits: 1, windowEndMs: Date.now() + 60_000 })
        .mockRejectedValueOnce(new Error('down again')),
    } as unknown as ThrottleCounterRepository;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { names, restore } = captureMetricNames();
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    try {
      await storage.increment('key-f', 60_000, 5, 60_000, 'default'); // fails — episode starts
      await storage.increment('key-f', 60_000, 5, 60_000, 'default'); // still failing — same episode
      await storage.increment('key-f', 60_000, 5, 60_000, 'default'); // a single success — not sustained, episode stays open
      await storage.increment('key-f', 60_000, 5, 60_000, 'default'); // fails again — still the same episode
    } finally {
      restore();
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(names.filter((n) => n === 'ThrottleStoreDegraded')).toHaveLength(1);
  });

  it('ends the episode and logs a distinct recovery line only once the store has been quiet, then reports a fresh episode on the next failure', async () => {
    jest.useFakeTimers();
    try {
      const repo = {
        increment: jest
          .fn()
          .mockRejectedValueOnce(new Error('down'))
          .mockResolvedValue({ hits: 1, windowEndMs: Date.now() + 60_000 }),
      } as unknown as ThrottleCounterRepository;
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { names, restore } = captureMetricNames();
      const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

      try {
        await storage.increment('key-h', 60_000, 5, 60_000, 'default'); // fails — episode 1 starts
        await storage.increment('key-h', 60_000, 5, 60_000, 'default'); // succeeds immediately — too soon to count as recovered
        expect(logSpy).not.toHaveBeenCalled();

        jest.advanceTimersByTime(60_000);
        await storage.increment('key-h', 60_000, 5, 60_000, 'default'); // succeeds after the quiet period — episode 1 ends
        expect(logSpy).toHaveBeenCalledTimes(1);

        repo.increment = jest.fn().mockRejectedValue(new Error('down again'));
        await storage.increment('key-h', 60_000, 5, 60_000, 'default'); // fails — episode 2 starts
      } finally {
        restore();
      }

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(names.filter((n) => n === 'ThrottleStoreDegraded')).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never emits the degradation metric for a local stack', async () => {
    const repo = {
      increment: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as ThrottleCounterRepository;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { names, restore } = captureMetricNames();
    const storage = new DynamoThrottlerStorage(repo, configFor('local'));

    try {
      await storage.increment('key-g', 60_000, 5, 60_000, 'default');
    } finally {
      restore();
    }

    expect(names).toHaveLength(0);
  });

  it('never logs the throttle key, tracker, or a client IP', async () => {
    const repo = {
      increment: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as ThrottleCounterRepository;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage = new DynamoThrottlerStorage(repo, configFor('dev'));

    const secretKey = 'sha256-of-a-tracker-and-route-should-never-appear';
    await storage.increment(secretKey, 60_000, 5, 60_000, 'default');

    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(secretKey);
  });
});
