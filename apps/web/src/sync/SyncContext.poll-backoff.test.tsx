/**
 * SyncProvider error-state poll cadence driven by the shared full-jitter backoff.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listFailedErrors, listPendingMutations, writeDeviceMetadata } from '../db/store';
import { SyncApiError } from './sync-client';
import { SyncProvider } from './SyncContext';
import { fake, Probe, renderProvider, seedMutation, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// Poll cadence is driven from refs,
// not effect deps, AND from the shared full-jitter backoff
// module rather than a flat 30s constant. The polling effect is mount-once
// and recomputes its next delay from stateKindRef/pendingCountRef/
// errorCounterRef at each tick completion. `Math.random` is pinned to `1`
// throughout this block so every full-jitter draw lands on its ceiling —
// `retry-backoff.test.ts` already proves the draws are actually random; this
// block proves the SCHEDULER is wired to the module's ceilings, not that the
// module itself is random.
describe('SyncProvider — error-state poll cadence (backoff)', () => {
  const POLL_IDLE_MS = 5 * 60 * 1000;
  const POLL_ACTIVE_MS = 30 * 1000;
  // Ceilings at Math.random() === 1: nextRetryDelayMs(0..3) = 15s/30s/60s/120s(cap).
  const CEILING = [15_000, 30_000, 60_000, 120_000, 120_000];
  // Added on top of every expected delay before checking a cumulative call
  // count. Every advance below deliberately OVERSHOOTS its target rather
  // than landing exactly on it or pre-checking "not yet" — exact-boundary
  // timer semantics under fake-indexeddb + fake timers proved unreliable to
  // hit precisely across several chained async hops, and a cumulative-count
  // check after a generous overshoot catches the same class of bug (a wrong
  // — too-short OR too-long — delay) without needing that precision: a
  // shorter-than-expected delay would already show up as an extra call at
  // an EARLIER checkpoint, and a longer one simply wouldn't have fired yet.
  const OVERSHOOT = 500;
  // fake-indexeddb schedules its transaction-completion callback via
  // `setImmediate` (`fake-indexeddb/build/esm/lib/scheduling.js`). Vitest's
  // default fake-timer set intercepts `setImmediate` too, which deadlocks
  // any IDB read/write awaited WHILE fake timers are active with nothing
  // concurrently advancing the clock to unblock it (seeding a fresh
  // mutation mid-test, for instance). Excluding `setImmediate` from the
  // faked set lets fake-indexeddb keep resolving over the REAL event loop
  // — instantly, in real time — while `setTimeout`/`Date`, all this block's
  // scheduler cares about, stay fully controlled by `advanceTimersByTimeAsync`.
  const FAKE_TIMERS_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  };

  useSyncTestHooks('hh-1');

  beforeEach(async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  /**
   * `vi.advanceTimersByTimeAsync` advances and flushes only what the FAKE
   * clock controls (`setTimeout`/`setInterval`/`Date`) plus plain
   * microtasks — with `setImmediate` deliberately excluded from the faked
   * set (see `FAKE_TIMERS_OPTS`), a poll tick's `pull`/`flushPending` chain
   * resolves its fake-indexeddb calls on the REAL event loop, which can
   * still be mid-flight when `advanceTimersByTimeAsync` returns. Draining a
   * few rounds of the real `setImmediate` queue afterward lets that chain
   * actually finish before the next assertion reads its result.
   */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 50; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  it('paces the next poll from the backoff ceilings after consecutive poll-tick errors, doubling until the 2-minute cap — never a flat 30s or a re-arm at 5 minutes', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    await seedMutation({ id: 'cadence-mut' });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    // Fake timers BEFORE render so the mount-armed poll timer is a fake
    // timer we can drive. `advanceTimersByTimeAsync` flushes the
    // intervening microtasks (incl. fake-indexeddb promises + the async
    // pull/flush chain) between timer fires. Assertions read `pushCalls`
    // (not the DOM via waitFor, which polls on real timers and stalls
    // under fake timers).
    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      // Settle the mount-time initialSync (pull ok → synced). initialSync
      // does NOT flush, so no push fires yet.
      await advance(50);
      expect(pushCalls).toBe(0);

      // Mount armed the poll at POLL_IDLE_MS. The FIRST tick pulls ok then
      // flushes → push fails (attempt 0 → 15s ceiling at Math.random()===1).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      let calls = pushCalls;
      expect(calls).toBe(1);

      for (const ceiling of CEILING) {
        await advance(ceiling + OVERSHOOT);
        expect(pushCalls).toBe(calls + 1);
        calls = pushCalls;
      }
    } finally {
      // Unmount BEFORE restoring real timers so any in-flight provider
      // timer is cleared by the effect cleanup, then drop the DB cleanly.
      cleanup();
      vi.useRealTimers();
    }
  });

  it('resets the counter on the first successful tick — a subsequent error starts back at the attempt-0 ceiling, not continued growth', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    let pushShouldFail = true;
    fake.pushImpl = async (args) => {
      pushCalls += 1;
      if (pushShouldFail) throw new Error('push boom');
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };

    await seedMutation({ id: 'reset-mut-1' });
    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);

      // Two consecutive errors: attempt 0 (15s) then attempt 1 (30s).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);

      // Let the NEXT natural poll tick succeed instead (the same mutation
      // finally applies) — this is the "first successful tick" the counter
      // must reset on. Nothing pending afterward, so the next tick is
      // armed at the idle cadence (POLL_IDLE_MS), not the grown ceiling.
      pushShouldFail = false;
      await advance(CEILING[1] + OVERSHOOT);
      expect(pushCalls).toBe(3);

      // Queue a fresh mutation and fail again, on the NEXT natural poll
      // tick. If the counter had NOT reset, this tick's failure would
      // schedule the FOLLOWING retry at the already-grown 60s ceiling; it
      // must schedule it at 15s (attempt 0) instead.
      pushShouldFail = true;
      await seedMutation({ id: 'reset-mut-2' });
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(4);

      // If the counter had NOT reset, the retry above would still be
      // pending 60s out — confirm it instead fires within the attempt-0
      // window.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(5);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('resets the counter on a user-initiated forceRefresh — a false-green cadence test would never notice a missing reset here', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'force-mut-1' });
      renderProvider();
      await advance(50);

      // Two consecutive errors grow the counter to attempt 1 (30s ceiling)
      // — the poll timer is now armed to fire again ~30s after this point,
      // regardless of anything forceRefresh does (forceRefresh never
      // touches the poll timer, only the counter and, via its own
      // bootstrap, local state).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);

      // A user-initiated full refresh resets the counter regardless of its
      // own outcome (the bootstrap succeeds here — a different transport
      // than the failing push, so it does not itself re-advance the
      // counter). The wipe drops the still-queued 'force-mut-1', so queue a
      // fresh mutation for the already-armed next tick to fail on.
      fireEvent.click(screen.getByText('forceRefresh'));
      await advance(50);
      await seedMutation({ id: 'force-mut-2' });

      // The already-armed tick fires ~30s after the SECOND error above,
      // unaffected by forceRefresh's timing — confirm it still fires and
      // fails (on the fresh mutation), which is what re-advances the
      // counter from the reset value of 0.
      await advance(CEILING[1] + OVERSHOOT);
      expect(pushCalls).toBe(3);

      // The FOLLOWING retry must fire within the attempt-0 window (15s) —
      // proof the counter was at 0 (not 2) when the tick above's catch
      // ran, since a not-reset counter would put this at the 60s ceiling
      // (still pending at this checkpoint).
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(4);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('resets the counter on the badge\'s "Retry now" — a deliberate click is a signal to try again now, not a claim the server recovered', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'retrynow-mut-1' });
      renderProvider();
      await advance(50);

      // One error: counter is 1, and the poll timer is armed to fire again
      // ~15s from here regardless of anything "Retry now" does (it never
      // touches the poll timer).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // "Retry now" resets the counter to 0 THEN attempts its own flush of
      // the still-queued mutation, which fails too (re-advancing it to 1)
      // — the counter ends at 1 either way, so the reset is invisible
      // here; it is only visible in the NEXT two ticks below.
      fireEvent.click(screen.getByText('retryNow'));
      await advance(50);
      expect(pushCalls).toBe(2);

      // The already-armed poll tick fires ~15s after the FIRST error
      // (unaffected by the click's timing) and fails again, advancing the
      // counter from 1 (post-click) to 2 — attempt 1, a 30s ceiling for
      // the FOLLOWING retry. Without the reset the counter would have been
      // 2 (unchanged by a no-op click) advancing to 3 here — attempt 2, a
      // 60s ceiling instead.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(3);

      // Fires within the 30s window — still pending at this checkpoint if
      // the counter had NOT reset (which would need the 60s ceiling).
      await advance(CEILING[1] + OVERSHOOT);
      expect(pushCalls).toBe(4);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('a batch parked by a permanent rejection code never advances the counter, and the resulting cadence is not faster than today\'s', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: 'cursor-1', hasMore: false };
    };
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new SyncApiError('ENCRYPTION_REQUIRED', 'no envelope', 403, 'trace-perm');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'perm-park-mut' });
      renderProvider();
      await advance(50);

      // First tick: the batch is parked as failed-error. Nothing is left
      // pending (it was the only mutation), so the badge stays 'error'
      // forever via the badge-truthfulness guard — never via a fresh catch
      // — and the counter is never fed.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      // 2 pulls by now: the mount-time `initialSync` pull, plus this first
      // scheduled poll tick's own pull.
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(1);
      expect(await listFailedErrors()).toHaveLength(1);
      expect(await listPendingMutations()).toHaveLength(0);

      // Whichever post-park behavior the loop has, pin it here: with
      // nothing pending to push, `pushCalls` can't distinguish cadences —
      // every subsequent tick just pulls. Track PULLS instead, which fire
      // on every tick regardless of pending work. If the fallback
      // mistakenly used the short full-jitter ceilings (15s/30s/60s) the
      // second pull would already have happened well before this point —
      // it must not have, proving the fallback is NOT the attempt-0+
      // backoff (which would poll the server far MORE often than today's
      // flat retry, exactly the load increase the permanent-park carve-out
      // exists to prevent).
      await advance(CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(1);

      // And it DOES eventually poll again, at the same idle cadence a
      // lingering 'stale' (conflicts) badge already uses.
      await advance(POLL_IDLE_MS - CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(3);
      // Still never resent (see the dedicated permanent-push
      // rejection park suite for the resend guarantee itself).
      expect(pushCalls).toBe(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('a served Retry-After under the cap overrides the computed delay in the scheduler', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      // 5s Retry-After — well under both the attempt-0 ceiling (15s at
      // Math.random()===1) and the 2-minute cap, so it must win. At
      // Math.random()===1 the override rule adds the maximum 20% jitter:
      // 5000 + 1 × 0.2 × 5000 = 6000ms.
      throw new SyncApiError('UPSTREAM_ERROR', 'busy', 429, 'trace-ra', 5_000);
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'override-mut' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // ~6000ms (see above) — well before the ignored 15s ceiling would
      // otherwise fire (proving the override, not the computed delay, won).
      await advance(6_000 + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('a served Retry-After above the cap does NOT override — the computed backoff applies', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      // 200s Retry-After — above the 120s cap, so it must be ignored.
      throw new SyncApiError('UPSTREAM_ERROR', 'busy', 429, 'trace-ra2', 200_000);
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'override-cap-mut' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // The ignored-override computed delay is the attempt-0 ceiling (15s).
      // If the 200s override had wrongly applied, this would still be 1.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('refocusing during an error-state backoff waits min(remaining backoff, 5s + jitter), never immediately and never longer than the remaining wait', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'refocus-mut' });
      renderProvider();
      await advance(50);

      // First error: attempt 0 → 15s ceiling (Math.random() === 1).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Refocus 2s into the 15s wait: remaining ≈ 13s; the refocus wait at
      // Math.random() === 1 is 5s + 1s jitter = 6s, so min(13s, 6s) = 6s —
      // neither immediate (0) nor the full remaining ~13s.
      await advance(2_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      // Not immediate.
      expect(pushCalls).toBe(1);
      // Fires ~6s post-refocus, well before the original ~13s remaining
      // would (proving the gate, not the un-gated backoff, applied).
      await advance(6_000 + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('refocusing near the END of a short remaining backoff waits the remaining time, not the longer refocus formula', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'refocus-mut-2' });
      renderProvider();
      await advance(50);

      // First error: attempt 0 → 15s ceiling (Math.random() === 1).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Refocus with only ~2s left of the 15s wait: remaining (~2s) is
      // SHORTER than the refocus formula (5s + 1s jitter = 6s at
      // Math.random()===1), so min(remaining, 6s) = remaining — the gate
      // must never wait LONGER than the backoff already remaining.
      await advance(13_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      expect(pushCalls).toBe(1);
      // Fires within ~2s (the remaining backoff), well short of the 6s
      // refocus formula — proof `min()` picked the shorter remaining time.
      await advance(2_000 + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A transient error raised OUTSIDE a poll tick
  // (notifyPending's own flush, here) must re-arm the scheduler to the
  // ceiling immediately — leaving the mount-armed POLL_IDLE_MS (5-minute)
  // timer as the only thing scheduled would ignore the shared backoff
  // policy for the whole remainder of that wait.
  it('a transient error raised by notifyPending (outside any poll tick) re-arms the scheduler to the ceiling instead of waiting out the already-armed cadence', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);
      expect(pushCalls).toBe(0);

      // Queue a mutation and flush it via notifyPending, well before the
      // mount-armed 5-minute poll timer would ever fire on its own.
      await seedMutation({ id: 'rearm-notify-mut' });
      fireEvent.click(screen.getByText('notifyPending'));
      await advance(50);
      expect(pushCalls).toBe(1);

      // Without the fix, the next retry would only be reachable at the
      // mount-armed POLL_IDLE_MS (~5 minutes) deadline. With the fix it is
      // reachable at the attempt-0 backoff ceiling (15s).
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // Same gap for a mount-time bootstrap failure — the
  // FIRST error raised for the whole provider, entirely outside any poll
  // tick.
  it('a mount-time bootstrap failure re-arms the scheduler to the ceiling instead of leaving the mount-armed 5-minute timer as the only scheduled retry', async () => {
    fake.bootstrapImpl = async () => {
      throw new Error('bootstrap boom');
    };
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '0', hasMore: false };
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);
      // The mount-time bootstrap failed before the poll ever ran a `pull`.
      expect(pullCalls).toBe(0);

      // Without the fix, the poll's own retry (a `pull`, on the next tick)
      // is not reachable until the mount-armed POLL_IDLE_MS (5 min) timer
      // fires. With the fix, the bootstrap failure re-arms it to the
      // attempt-0 ceiling (15s) immediately.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pullCalls).toBe(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // `rearmNowRef` re-armed the timer
  // on a mount-time bootstrap failure but never published a deadline, so
  // `nextRetryAt` stayed at its initial `null` for the WHOLE first backoff —
  // the badge shows the static "Sync failed" copy instead of a countdown for
  // exactly the outage this deliverable ships the countdown for.
  it('a mount-time bootstrap failure publishes a next-retry-at deadline, not just a re-armed timer', async () => {
    fake.bootstrapImpl = async () => {
      throw new Error('bootstrap boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);

      expect(screen.getByTestId('state')).toHaveTextContent('error');
      // Without the fix this stays '' (nextRetryAt === null) until a poll
      // tick completes — up to 5 minutes away.
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A non-tick rearm
  // (here, a failed `retryNow`) must overwrite the previously-published
  // deadline with its OWN, later one — not leave the stale deadline in
  // place. A refocus that lands after the stale deadline but before the
  // real, republished one must still honor the refocus gate (wait, not poll
  // immediately); with the bug, the stale-past deadline reads as "no wait
  // owed" and `schedule(0)` fires an immediate poll at a server that just
  // failed.
  it('a non-tick rearm republishes the deadline so a later refocus does not read a stale-past one and poll immediately', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'stale-deadline-mut' });
      renderProvider();
      await advance(50);

      // First tick fails: attempt 0 → 15s ceiling (Math.random() === 1).
      // Publishes deadline1 = now + 15s.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      const deadline1 = Number(screen.getByTestId('next-retry-at').textContent);
      expect(Number.isNaN(deadline1)).toBe(false);

      // 5s later, the user clicks "Retry now". It fails too (push always
      // throws), resetting then re-raising the counter back to attempt 0,
      // and re-arms from THIS moment — deadline2 = now + 15s, which lands
      // 5s AFTER deadline1 (still un-elapsed at click time).
      await advance(5_000);
      fireEvent.click(screen.getByText('retryNow'));
      await advance(50);
      expect(pushCalls).toBe(2);
      const deadline2 = Number(screen.getByTestId('next-retry-at').textContent);
      expect(Number.isNaN(deadline2)).toBe(false);
      // The republished deadline must have moved — proof the rearm actually
      // updated it rather than leaving deadline1 in place.
      expect(deadline2).toBeGreaterThan(deadline1);

      // Advance past deadline1 (10s further, i.e. 15s since retryNow fired 5s
      // in) but still ~4s short of deadline2, and refocus.
      await advance(11_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      // Not immediate: a stale deadline1 (already elapsed) would have read
      // as "no wait owed" and fired `schedule(0)` here.
      expect(pushCalls).toBe(2);
      // Fires once the real (deadline2-derived) remaining wait elapses.
      await advance(4_000 + OVERSHOOT);
      expect(pushCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // The old carve-out (`errorCounterRef.current === 0 && failedErrorCountRef > 0`)
  // stopped applying the instant ANY transient error preceded the park, even
  // once that error's own attempt was long over — freezing the counter above
  // 0 and falling through to the backoff (~4x more frequent than today's
  // flat cadence) for as long as the park lingers, i.e. forever.
  it('a permanent park landing AFTER a prior transient error still polls no faster than the idle/active cadence', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: 'cursor-1', hasMore: false };
    };
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      if (pushCalls === 1) throw new Error('transient blip');
      throw new SyncApiError('ENCRYPTION_REQUIRED', 'no envelope', 403, 'trace-perm-2');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'transient-then-park-mut' });
      renderProvider();
      await advance(50);

      // First tick: a plain transient push failure — the counter advances
      // to 1 (attempt-0 ceiling, 15s, for the NEXT retry).
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Second tick, ~15s later: the SAME batch now comes back with a
      // permanent rejection code and is parked. The counter is frozen at 1
      // (never reset — the badge stays 'error' via the park forever, never
      // via a fresh catch) — exactly the nonzero-counter ordering the old
      // carve-out missed.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);
      expect(await listPendingMutations()).toHaveLength(0);

      // Nothing is left to push from here — every later tick just pulls.
      // If the exclusive counter-===-0 gate were still in effect, the
      // frozen counter of 1 would fall through to the backoff at
      // attempt 0 (ceiling 15s) — the next pull below would already have
      // happened. It must not have.
      const pullsAfterPark = pullCalls;
      await advance(CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(pullsAfterPark);
      expect(pushCalls).toBe(2);

      // It DOES eventually poll again, at the same idle cadence a lingering
      // 'stale' (conflicts) badge already uses — never resent.
      await advance(POLL_IDLE_MS - CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(pullsAfterPark + 1);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // The tick that lands a permanent park was
  // gating the counter reset on the FINAL projected badge `kind`, which the
  // badge-truthfulness guard still reports as `'error'` for the lingering
  // park — so the reset never ran and a LATER, wholly independent transient
  // failure (a different aggregate) kept advancing from the park's stale
  // attempt count instead of starting over at attempt 0.
  it('a later independent transient failure starts fresh at attempt 0, not from the frozen count of an earlier resolved park', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async (args) => {
      pushCalls += 1;
      const aggregateId = args.mutations[0]?.aggregateId;
      if (aggregateId === 'agg-park') {
        if (pushCalls === 1) throw new Error('transient blip');
        throw new SyncApiError('ENCRYPTION_REQUIRED', 'no envelope', 403, 'trace-perm-3');
      }
      // The unrelated later mutation always fails transiently — its own
      // retry cadence is what this test pins.
      throw new Error('later transient boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'park-mut', aggregateId: 'agg-park' });
      renderProvider();
      await advance(50);

      // Tick 1: transient failure on agg-park. Attempt 0 → 15s ceiling.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Tick 2, ~15s later: agg-park comes back permanently rejected and
      // parks. This tick raised no NEW transient failure, so the fix resets
      // the counter here even though the badge stays 'error' (the park).
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);

      // An unrelated mutation arrives. The park still lingers (failedError
      // count > 0), so nothing pushes faster than the idle cadence.
      await seedMutation({ id: 'later-mut', aggregateId: 'agg-later' });
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(3);

      // This transient failure is a genuinely fresh attempt 0 → its own
      // retry (floored at the active cadence while pending, 30s either way)
      // is not yet discriminating; the SECOND consecutive failure is.
      await advance(POLL_ACTIVE_MS + OVERSHOOT);
      expect(pushCalls).toBe(4);

      // With the fix (attempt 1 → 30s ceiling, matching the active-cadence
      // floor): the next retry lands at +30s. Without it (the counter
      // frozen at the park's stale 1, so this is really attempt 2 → 60s
      // ceiling): it would not have landed yet.
      await advance(CEILING[1] + OVERSHOOT);
      expect(pushCalls).toBe(5);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A permanent park never
  // resends anything, so promising an automatic retry for it is false. No
  // `nextRetryAt` deadline may be published while the error state is a pure
  // park (nothing else pending) — the badge falls back to its static
  // "Some edits could not be sent" label instead of a live countdown to a
  // retry that will never happen (SyncBadge.test.tsx pins the badge's own
  // rendering given a null deadline; this pins that the context actually
  // produces one for this state).
  it('a pure permanent-park error state publishes no retry deadline', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    fake.pushImpl = async () => {
      throw new SyncApiError('ENCRYPTION_REQUIRED', 'no envelope', 403, 'trace-pure-park');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'pure-park-deadline-mut' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(await listFailedErrors()).toHaveLength(1);
      expect(screen.getByTestId('state')).toHaveTextContent('error');
      expect(screen.getByTestId('next-retry-at')).toHaveTextContent('');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // The poll tick pairs `pull` with an unconditional
  // `flushPending`, and with nothing queued (the normal idle case) the
  // flush's empty-queue branch declared 'synced' straight over the transient
  // error the pull had JUST raised — dropping its Retry-After, the
  // backoff, the error badge and the countdown, and re-arming the next
  // attempt a full POLL_IDLE_MS out.
  it('a transient pull failure on an idle tick (nothing queued) keeps the error state and honors its Retry-After instead of being erased by the empty flush', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      // The mount-time initialSync pull succeeds; every scheduled tick's
      // pull is throttled with a 60s Retry-After.
      if (pullCalls === 1) return { changes: [], newCursor: 'cursor-1', hasMore: false };
      throw new SyncApiError('UPSTREAM_ERROR', 'busy', 429, 'trace-idle-pull', 60_000);
    };
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('nothing is queued — never reached');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);
      expect(pullCalls).toBe(1);
      expect(screen.getByTestId('state')).toHaveTextContent('synced');

      // First scheduled tick: the pull is throttled. Nothing is queued, so
      // the flush that follows has no network work of its own.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(0);
      // Without the fix these read 'synced' and '' — the empty flush's
      // no-op 'synced' claim overwrote the pull's error.
      expect(screen.getByTestId('state')).toHaveTextContent('error');
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');

      // The served 60s (+ the maximum 20% jitter at Math.random()===1 =
      // 72s) wins over both the computed attempt-0 ceiling and the idle
      // cadence. Without the fix the next pull is a full POLL_IDLE_MS out.
      await advance(72_000 + OVERSHOOT);
      expect(pullCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // SyncProvider never remounts across a household
  // change (AuthAwareProviders re-renders it with a new prop, no key), and
  // the household-transition effect reset only the freshness pin — so
  // household A's consecutive-error count, its published deadline and its
  // armed backoff all leaked into household B. B's FIRST transient error
  // then waited at A's already-grown ceiling instead of the attempt-0
  // interval, and the badge could count down to a deadline that was never
  // B's own.
  function SwitchableProvider({ initial }: { initial: string }) {
    const [hh, setHh] = useState(initial);
    return (
      <SyncProvider
        householdId={hh}
        deviceId="dev-test"
        apiBaseUrl=""
        getAccessToken={() => 'tok'}
        getCsrfToken={() => 'csrf'}
        mock
      >
        <Probe />
        <button onClick={() => setHh('hh-B')}>switch</button>
      </SyncProvider>
    );
  }

  it('a household switch resets the retry policy — the new household\'s first transient error waits the attempt-0 interval, not an inherited grown ceiling, and inherits no deadline', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-A',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-A', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async () => {
      pushCalls += 1;
      throw new Error('push boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'switch-mut' });
      render(<SwitchableProvider initial="hh-A" />);
      await advance(50);

      // Household A: two consecutive tick failures grow the counter to 2 —
      // its next ceiling (armed now) is 30s, and the one after that 60s.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');

      // Switch to household B before any successful tick. B's initialSync
      // (a pull — the cursor is non-zero) succeeds; a successful sync never
      // resets the counter on its own.
      fireEvent.click(screen.getByText('switch'));
      await advance(50);
      expect(screen.getByTestId('state')).toHaveTextContent('synced');
      // A's deadline is not B's: without the fix it survives the switch.
      expect(screen.getByTestId('next-retry-at')).toHaveTextContent('');

      // B's first push failure (the still-queued mutation). With the fix
      // this is attempt 0 → 15s ceiling. Without it the inherited count of
      // 2 makes it attempt 2 → a 60s ceiling, still pending at the check.
      fireEvent.click(screen.getByText('notifyPending'));
      await advance(50);
      expect(pushCalls).toBe(3);
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(4);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // `notifyPending` re-armed
  // the poll timer after EVERY flush, gated only on the projected badge kind
  // — which the badge-truthfulness guard pins at 'error' for as long as a
  // permanently parked batch lingers. Each successful edit-driven push then
  // re-armed the pull a full idle cadence out, so a user editing more often
  // than once per POLL_IDLE_MS never ran a pull tick again for the session:
  // no remote changes, no `refreshCounts`, no new-build detection.
  it('successful edit-driven pushes while a parked batch lingers leave the armed poll alone, so the pull tick still fires on its cadence', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: 'cursor-1', hasMore: false };
    };
    fake.pushImpl = async (args) => {
      if (args.mutations.some((m) => m.aggregateId === 'agg-park')) {
        throw new SyncApiError('ENCRYPTION_REQUIRED', 'no envelope', 403, 'trace-park-starve');
      }
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'park-mut', aggregateId: 'agg-park' });
      renderProvider();
      await advance(50);
      expect(pullCalls).toBe(1);

      // First tick: the batch parks. The badge is pinned at 'error' from
      // here on, and the tick re-armed the next pull at POLL_IDLE_MS.
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);

      // Two ordinary edits, each pushed cleanly, spaced well under
      // POLL_IDLE_MS — the pattern of a person working in the app.
      for (const id of ['edit-1', 'edit-2']) {
        await advance(2 * 60_000);
        await seedMutation({ id, aggregateId: `agg-${id}` });
        fireEvent.click(screen.getByText('notifyPending'));
        await advance(50);
        expect(await listPendingMutations()).toHaveLength(0);
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      }

      // ~4 min past the park tick so far; its armed pull is due at 5 min.
      // Without the fix the second edit re-armed it to ~9 min out.
      await advance(60_000 + OVERSHOOT);
      expect(pullCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // `syncRoundTrip` — the popover's "Sync now",
  // the one control offered from the synced/pending states — was the only
  // non-tick raise path that never re-armed the scheduler or published a
  // deadline, so a failure there left the badge on the static "Sync failed"
  // with no countdown and the poll still armed at the pre-failure cadence
  // (up to POLL_IDLE_MS) until some later tick happened to republish.
  it('a transient pull failure raised by "Sync now" (syncRoundTrip) publishes a countdown deadline and re-arms the scheduler to the ceiling', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      if (pullCalls === 1) return { changes: [], newCursor: 'cursor-1', hasMore: false };
      throw new Error('pull boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);
      expect(pullCalls).toBe(1);
      expect(screen.getByTestId('state')).toHaveTextContent('synced');

      fireEvent.click(screen.getByText('syncRoundTrip'));
      await advance(50);
      expect(pullCalls).toBe(2);
      expect(screen.getByTestId('state')).toHaveTextContent('error');
      // Without the fix this reads '' — no tick had published a deadline
      // yet and nothing on this path republished one.
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');

      // And the retry is reachable at the attempt-0 ceiling, not only at
      // the mount-armed POLL_IDLE_MS.
      await advance(CEILING[0] + OVERSHOOT);
      expect(pullCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

});
