// `ThrottlerStorage` backed by ThrottleCounterRepository so the global ThrottlerGuard counts across warm Lambda instances. Failure
// policy: a failed or slow store call degrades to the in-memory storage, reported once per episode.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { EnvConfig } from '../common/env.config.js';
import { emitOperationalMetric } from '../common/operational-metrics.js';
import { ThrottleCounterRepository } from '../dynamo/throttle-counter.repository.js';

// `ThrottlerStorageRecord` is not exported from the package root; derive it from the interface method.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// Store-call deadline: bounds a hung DynamoDB dependency without touching the shared client retry policy.
const STORE_DEADLINE_MS = 200;

// Quiet period before a degradation episode ends: DynamoDB failures flap, and clearing the flag on the first success
// would re-report on the next failure and collapse to per-request emission.
const RECOVERY_QUIET_MS = 60_000;

@Injectable()
export class DynamoThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(DynamoThrottlerStorage.name);
  // The package own storage, reused as the degraded-mode fallback.
  private readonly fallback = new ThrottlerStorageService();
  private readonly stack: string;
  // True while the current episode was already reported, so an outage or flap logs and emits once.
  private degraded = false;
  // Set on every failed store call, so a later success can tell whether the store has been quiet long enough.
  private lastFailureAt = 0;

  constructor(
    private readonly repo: ThrottleCounterRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.stack = config.get('STACK', { infer: true }) ?? 'local';
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const controller = new AbortController();
    const primary = this.repo.increment(key, ttl, controller.signal);
    // The deadline can win while `primary` is in flight, which later rejects from the abort; the no-op handler
    // keeps that loser from being unhandled.
    primary.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout>;
    // A second bound beside `abortSignal`: the abort asks the SDK to stop, but this class deadline must not depend
    // on the dependency honouring it.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`throttle store call exceeded its ${STORE_DEADLINE_MS}ms deadline`));
      }, STORE_DEADLINE_MS);
    });
    try {
      const { hits, windowEndMs } = await Promise.race([primary, deadline]);
      this.reportRecovery();
      return this.toRecord(hits, windowEndMs, limit);
    } catch (err) {
      this.reportDegradation(err);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    } finally {
      clearTimeout(timer!);
    }
  }

  // No route sets a `blockDuration` distinct from `ttl`, so a fixed window blocking until it rolls over matches the
  // package block-expiry tracking.
  private toRecord(hits: number, windowEndMs: number, limit: number): ThrottlerStorageRecord {
    const timeToExpire = Math.max(0, Math.ceil((windowEndMs - Date.now()) / 1000));
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }

  // Once per episode: a structured warning plus the `ThrottleStoreDegraded` metric (never on `local`). Never logs the
  // throttle key, tracker or client IP.
  private reportDegradation(err: unknown): void {
    this.lastFailureAt = Date.now();
    if (this.degraded) return;
    this.degraded = true;
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `Throttle store unavailable; degrading to instance-local counting: ${message}`,
    );
    if (this.stack !== 'local') {
      emitOperationalMetric({
        namespace: `Retivo/${this.stack}/Security`,
        name: 'ThrottleStoreDegraded',
        value: 1,
      });
    }
  }

  // Ends the episode only after `RECOVERY_QUIET_MS` without a failure, since a success amid a flap is not recovery; the
  // log line differs from the degradation warning.
  private reportRecovery(): void {
    if (!this.degraded) return;
    if (Date.now() - this.lastFailureAt < RECOVERY_QUIET_MS) return;
    this.degraded = false;
    this.logger.log('Throttle store recovered; resuming shared counting.');
  }
}
