// SyncProvider error-state poll cadence driven by the shared full-jitter backoff.
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listFailedErrors, listPendingMutations, writeDeviceMetadata } from '../db/store';
import { SyncApiError } from './sync-client';
import { SyncProvider } from './SyncContext';
import { fake, Probe, renderProvider, seedMutation, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// The scheduler reads refs, not effect deps. `Math.random` is pinned to 1 so every full-jitter draw lands on its ceiling.
describe('SyncProvider — error-state poll cadence (backoff)', () => {
  const POLL_IDLE_MS = 5 * 60 * 1000;
  const POLL_ACTIVE_MS = 30 * 1000;
  // Ceilings at Math.random() === 1: nextRetryDelayMs(0..3) = 15s/30s/60s/120s(cap).
  const CEILING = [15_000, 30_000, 60_000, 120_000, 120_000];
  // Added to every expected delay: exact-boundary timer semantics under fake-indexeddb are unreliable, and a cumulative
  // call count after an overshoot still catches a delay that is too short or too long.
  const OVERSHOOT = 500;
  // fake-indexeddb completes transactions via `setImmediate`; faking it would deadlock any IDB call awaited under fake
  // timers, so only the timers the scheduler uses are faked.
  const FAKE_TIMERS_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  };

  useSyncTestHooks('hh-1');

  beforeEach(async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  // Drains the real `setImmediate` queue after advancing so a tick's fake-indexeddb chain finishes before the next assertion.
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

    // Fake timers go on before render so the mount-armed poll timer is drivable; assertions read call counts because
    // waitFor polls on real timers.
    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      renderProvider();
      await advance(50);
      expect(pushCalls).toBe(0);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      let calls = pushCalls;
      expect(calls).toBe(1);

      for (const ceiling of CEILING) {
        await advance(ceiling + OVERSHOOT);
        expect(pushCalls).toBe(calls + 1);
        calls = pushCalls;
      }
    } finally {
      // Unmount before restoring real timers so the provider clears its in-flight timer.
      cleanup();
      vi.useRealTimers();
    }
  });

  // The first error after a reset trigger waits the attempt-0 ceiling, not the grown one a missing reset would leave.
  it.each<[string, (push: { calls: number; fail: boolean }) => Promise<void>]>([
    [
      'the first successful tick',
      async (push) => {
        await seedMutation({ id: 'reset-mut-1' });
        renderProvider();
        await advance(50);
        await advance(POLL_IDLE_MS + OVERSHOOT);
        expect(push.calls).toBe(1);
        await advance(CEILING[0] + OVERSHOOT);
        expect(push.calls).toBe(2);

        push.fail = false;
        await advance(CEILING[1] + OVERSHOOT);
        expect(push.calls).toBe(3);

        push.fail = true;
        await seedMutation({ id: 'reset-mut-2' });
        await advance(POLL_IDLE_MS + OVERSHOOT);
        expect(push.calls).toBe(4);
        await advance(CEILING[0] + OVERSHOOT);
        expect(push.calls).toBe(5);
      },
    ],
    [
      'a user-initiated forceRefresh',
      async (push) => {
        await seedMutation({ id: 'force-mut-1' });
        renderProvider();
        await advance(50);
        await advance(POLL_IDLE_MS + OVERSHOOT);
        expect(push.calls).toBe(1);
        await advance(CEILING[0] + OVERSHOOT);
        expect(push.calls).toBe(2);

        // The bootstrap wipes the queued mutation, so queue a fresh one for the already-armed tick to fail on.
        fireEvent.click(screen.getByText('forceRefresh'));
        await advance(50);
        await seedMutation({ id: 'force-mut-2' });
        await advance(CEILING[1] + OVERSHOOT);
        expect(push.calls).toBe(3);
        await advance(CEILING[0] + OVERSHOOT);
        expect(push.calls).toBe(4);
      },
    ],
    [
      'the badge\'s "Retry now"',
      async (push) => {
        await seedMutation({ id: 'retrynow-mut-1' });
        renderProvider();
        await advance(50);
        await advance(POLL_IDLE_MS + OVERSHOOT);
        expect(push.calls).toBe(1);

        // The click resets the counter then fails its own flush, so the reset only shows in the next two ticks.
        fireEvent.click(screen.getByText('retryNow'));
        await advance(50);
        expect(push.calls).toBe(2);
        await advance(CEILING[0] + OVERSHOOT);
        expect(push.calls).toBe(3);
        await advance(CEILING[1] + OVERSHOOT);
        expect(push.calls).toBe(4);
      },
    ],
  ])('resets the retry counter on %s', async (_trigger, run) => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
    const push = { calls: 0, fail: true };
    fake.pushImpl = async (args) => {
      push.calls += 1;
      if (push.fail) throw new Error('push boom');
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
      await run(push);
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(1);
      expect(await listFailedErrors()).toHaveLength(1);
      expect(await listPendingMutations()).toHaveLength(0);

      // With nothing pending, pushCalls cannot tell cadences apart; pulls fire every tick, and none may come at the short ceilings.
      await advance(CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(1);

      await advance(POLL_IDLE_MS - CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(3);
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
      // 5s Retry-After beats the 15s ceiling; at Math.random() === 1 the override adds the maximum 20% jitter (6s).
      throw new SyncApiError('UPSTREAM_ERROR', 'busy', 429, 'trace-ra', 5_000);
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'override-mut' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

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
      // 200s Retry-After is above the 120s cap and is ignored.
      throw new SyncApiError('UPSTREAM_ERROR', 'busy', 429, 'trace-ra2', 200_000);
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'override-cap-mut' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Refocus 2s into the 15s wait waits min(remaining ~13s, 5s + 1s jitter) = 6s.
      await advance(2_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      expect(pushCalls).toBe(1);
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      // Refocus with ~2s left waits the remaining time, never the longer 6s refocus formula.
      await advance(13_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      expect(pushCalls).toBe(1);
      await advance(2_000 + OVERSHOOT);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A transient error raised outside a poll tick must publish a deadline and re-arm to the attempt-0 ceiling, not leave
  // the mount-armed 5-minute timer as the only scheduled retry.
  it.each<[string, () => Promise<() => number>]>([
    [
      'a mount-time bootstrap failure',
      async () => {
        fake.bootstrapImpl = async () => {
          throw new Error('bootstrap boom');
        };
        let pullCalls = 0;
        fake.pullImpl = async () => {
          pullCalls += 1;
          return { changes: [], newCursor: '0', hasMore: false };
        };
        renderProvider();
        await advance(50);
        return () => pullCalls;
      },
    ],
    [
      'notifyPending',
      async () => {
        let pushCalls = 0;
        fake.pushImpl = async () => {
          pushCalls += 1;
          throw new Error('push boom');
        };
        await writeDeviceMetadata({
          deviceId: 'dev-test',
          syncCursor: 'cursor-1',
          lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
          displayName: 'This device',
        });
        fake.pullImpl = async () => ({ changes: [], newCursor: 'cursor-1', hasMore: false });
        renderProvider();
        await advance(50);
        await seedMutation({ id: 'rearm-notify-mut' });
        fireEvent.click(screen.getByText('notifyPending'));
        await advance(50);
        return () => pushCalls;
      },
    ],
    [
      '"Sync now" (syncRoundTrip)',
      async () => {
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
        renderProvider();
        await advance(50);
        fireEvent.click(screen.getByText('syncRoundTrip'));
        await advance(50);
        return () => pullCalls;
      },
    ],
  ])('%s publishes a retry deadline and re-arms the scheduler to the ceiling', async (_entry, trigger) => {
    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      const attempts = await trigger();
      expect(screen.getByTestId('state')).toHaveTextContent('error');
      expect(Number(screen.getByTestId('next-retry-at').textContent)).toBeGreaterThan(Date.now());

      const before = attempts();
      await advance(CEILING[0] + OVERSHOOT);
      expect(attempts()).toBe(before + 1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A non-tick rearm (a failed `retryNow`) must overwrite the published deadline: a refocus after the stale deadline but
  // before the real one must still wait, not poll immediately.
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      const deadline1 = Number(screen.getByTestId('next-retry-at').textContent);
      expect(Number.isNaN(deadline1)).toBe(false);

      await advance(5_000);
      fireEvent.click(screen.getByText('retryNow'));
      await advance(50);
      expect(pushCalls).toBe(2);
      const deadline2 = Number(screen.getByTestId('next-retry-at').textContent);
      expect(Number.isNaN(deadline2)).toBe(false);
      expect(deadline2).toBeGreaterThan(deadline1);

      await advance(11_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      expect(pushCalls).toBe(2);
      await advance(4_000 + OVERSHOOT);
      expect(pushCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A permanent park after a prior transient error must not leave the counter above 0, which would put the park on the short backoff forever.
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);
      expect(await listPendingMutations()).toHaveLength(0);

      // With nothing to push, only pulls tell cadences apart; none may happen at the backoff ceilings.
      const pullsAfterPark = pullCalls;
      await advance(CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(pullsAfterPark);
      expect(pushCalls).toBe(2);

      await advance(POLL_IDLE_MS - CEILING[2] + OVERSHOOT);
      expect(pullCalls).toBe(pullsAfterPark + 1);
      expect(pushCalls).toBe(2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // The tick that lands a park must reset the counter even though the badge stays 'error', so a later independent failure starts at attempt 0.
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
      throw new Error('later transient boom');
    };

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    try {
      await seedMutation({ id: 'park-mut', aggregateId: 'agg-park' });
      renderProvider();
      await advance(50);

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);

      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);

      await seedMutation({ id: 'later-mut', aggregateId: 'agg-later' });
      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(3);

      await advance(POLL_ACTIVE_MS + OVERSHOOT);
      expect(pushCalls).toBe(4);

      // Attempt 1 waits 30s; a counter frozen by the park would make it attempt 2 at 60s.
      await advance(CEILING[1] + OVERSHOOT);
      expect(pushCalls).toBe(5);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // A pure park never resends, so no `nextRetryAt` countdown may be published for it.
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

  // A transient pull failure on an idle tick must survive the empty flush that follows, keeping its error state and Retry-After.
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(pushCalls).toBe(0);
      expect(screen.getByTestId('state')).toHaveTextContent('error');
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');

      // 60s Retry-After plus the maximum 20% jitter (72s) wins over the ceiling and the idle cadence.
      await advance(72_000 + OVERSHOOT);
      expect(pullCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  // SyncProvider is not remounted on a household change, so its retry policy, deadline and armed backoff must reset on the prop change.
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pushCalls).toBe(1);
      await advance(CEILING[0] + OVERSHOOT);
      expect(pushCalls).toBe(2);
      expect(screen.getByTestId('next-retry-at')).not.toHaveTextContent('');

      fireEvent.click(screen.getByText('switch'));
      await advance(50);
      expect(screen.getByTestId('state')).toHaveTextContent('synced');
      expect(screen.getByTestId('next-retry-at')).toHaveTextContent('');

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

  // A successful edit-driven push while a park lingers must not re-arm the poll a full idle cadence out, or an active user never runs a pull tick.
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

      await advance(POLL_IDLE_MS + OVERSHOOT);
      expect(pullCalls).toBe(2);
      expect(await listFailedErrors()).toHaveLength(1);

      for (const id of ['edit-1', 'edit-2']) {
        await advance(2 * 60_000);
        await seedMutation({ id, aggregateId: `agg-${id}` });
        fireEvent.click(screen.getByText('notifyPending'));
        await advance(50);
        expect(await listPendingMutations()).toHaveLength(0);
        expect(screen.getByTestId('state')).toHaveTextContent('error');
      }

      await advance(60_000 + OVERSHOOT);
      expect(pullCalls).toBe(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
