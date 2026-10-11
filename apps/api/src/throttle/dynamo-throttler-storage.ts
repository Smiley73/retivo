/**
 * `ThrottlerStorage` backed by the shared `ThrottleCounterRepository`.
 * Wired into `ThrottlerModule` in
 * `app.module.ts` in place of `@nestjs/throttler`'s default per-process
 * `ThrottlerStorageService`, so the global `ThrottlerGuard`'s count is the
 * same across every warm Lambda instance rather than per-instance.
 *
 * Owns four things: the atomic increment (delegated
 * to the repository), the expiry-from-stored-value window rule (also the
 * repository's job), the store-call deadline, and the bounded degraded-mode
 * fallback with its observability.
 *
 * **Failure policy — bounded degraded mode, not fail-open or fail-closed.**
 * A DynamoDB blip must never turn into an outage for an app holding
 * people's retirement plans (fail-closed), but it also must not silently
 * restore today's no-protection state without anyone finding out (plain
 * fail-open). So a failed or slow store call falls back to the package's
 * own in-memory `ThrottlerStorageService` — today's per-instance behaviour,
 * never worse — held as a single per-process instance here, and the
 * degradation is reported once per episode (a structured warning + an
 * allow-listed CloudWatch metric), not once per request: a store outage
 * means every request fails, and per-request emission would turn a
 * dependency blip into a log flood and a second incident. An episode isn't
 * over on the first success, either — the common DynamoDB failure shape is
 * a flap (fail, succeed, fail), not a clean outage, so the episode only
 * closes (and a distinct recovery line logs) once the store has gone
 * `RECOVERY_QUIET_MS` without another failure.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { EnvConfig } from '../common/env.config.js';
import { emitOperationalMetric } from '../common/operational-metrics.js';
import { ThrottleCounterRepository } from '../dynamo/throttle-counter.repository.js';

// `ThrottlerStorageRecord` isn't re-exported from the package root (only
// `ThrottlerStorage` is) — derive it structurally from the interface method
// this class implements rather than reaching into the package's dist path.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Store-call deadline (a couple of hundred milliseconds). Bounds a
 * hung DynamoDB dependency without touching the shared `DYNAMO_DOC_CLIENT`'s
 * own retry/timeout policy, which every other repository also relies on.
 */
const STORE_DEADLINE_MS = 200;

/**
 * How long the store must succeed continuously before a degradation episode
 * is considered over. A partial DynamoDB failure (a p99 latency shift, a hot
 * counter item, a cold Lambda's first call) flaps — fail, succeed, fail —
 * rather than failing every call the way a total outage does. Clearing the
 * degraded flag on the first success would end the episode on that flap and
 * re-report on the very next failure, collapsing to per-request emission.
 * Requiring a quiet period of sustained success keeps a flapping run inside
 * one episode.
 */
const RECOVERY_QUIET_MS = 60_000;

@Injectable()
export class DynamoThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(DynamoThrottlerStorage.name);
  /** The package's own storage, reused unmodified as the degraded-mode
   *  fallback — never a reimplementation. */
  private readonly fallback = new ThrottlerStorageService();
  private readonly stack: string;
  /** True while the current degradation episode has already been reported,
   *  so a sustained (or flapping) outage logs/emits exactly once until the
   *  store has recovered for `RECOVERY_QUIET_MS`. */
  private degraded = false;
  /** Set on every failed store call, degraded or not, so a later success can
   *  tell whether the store has been quiet for long enough to count as
   *  recovered. */
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
    // The deadline below can win the race while `primary` is still in
    // flight; it goes on to reject from the abort a tick later. Attach a
    // no-op handler now so that later rejection is never unhandled — the
    // race's loser is intentionally ignored, not a bug.
    primary.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout>;
    // A second, independent bound alongside `abortSignal`: `abortSignal`
    // asks the SDK to stop the outbound call promptly (saving wasted
    // DynamoDB capacity), but this class's own deadline guarantee must not
    // depend on the dependency actually honouring it.
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

  /**
   * This app never configures a `blockDuration` distinct from `ttl` (every
   * `@Throttle` call site omits it, so the guard defaults it to `ttl`), so a
   * fixed window that blocks until it rolls over — the counter's only
   * stored notion of "when does this reset" — is equivalent to the
   * package's separate block-expiry tracking for every route this app has.
   */
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

  /**
   * Once per degradation episode: a structured warning naming the store
   * error, and the allow-listed `ThrottleStoreDegraded` metric (dev + prod,
   * mirroring the other security-namespace metrics — never emitted for a
   * `local` stack). Never logs the throttle key, tracker, or a client IP.
   * A call that fails while an episode is already open only refreshes
   * `lastFailureAt` — it never re-reports.
   */
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

  /**
   * Ends the current degradation episode, but only once the store has gone
   * `RECOVERY_QUIET_MS` without a failure — a single success amid a flapping
   * failure pattern is not sustained recovery, and clearing the flag on it
   * would let the very next failure open (and report) a "new" episode that
   * is really the same incident continuing. Logs a one-line recovery
   * message distinct from the degradation warning so the two are never
   * confused in a log search.
   */
  private reportRecovery(): void {
    if (!this.degraded) return;
    if (Date.now() - this.lastFailureAt < RECOVERY_QUIET_MS) return;
    this.degraded = false;
    this.logger.log('Throttle store recovered; resuming shared counting.');
  }
}
