import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appToastQueue, raiseWaitNotice, type AppToastContent } from './toast-queue';

type WaitToastContent = Extract<AppToastContent, { kind: 'wait' }>;

function waitToasts(): { key: string; content: WaitToastContent }[] {
  return appToastQueue.visibleToasts
    .filter((t) => t.content.kind === 'wait')
    .map((t) => ({ key: t.key, content: t.content as WaitToastContent }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // The queue is a module-level singleton: close anything a test left live.
  for (const t of appToastQueue.visibleToasts) appToastQueue.close(t.key);
  vi.useRealTimers();
});

describe('raiseWaitNotice', () => {
  it('drops a non-positive wait (zero or negative)', () => {
    raiseWaitNotice(0);
    raiseWaitNotice(-100);
    expect(waitToasts()).toHaveLength(0);
  });

  it('drops a non-finite wait (NaN or Infinity)', () => {
    raiseWaitNotice(NaN);
    raiseWaitNotice(Infinity);
    expect(waitToasts()).toHaveLength(0);
  });

  it('raises exactly one wait toast at the requested deadline', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(5_000);
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_005_000 });
  });

  it('coalesces a LATER observation into the same single toast, extending the deadline', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(5_000); // deadline 1,005,000
    raiseWaitNotice(9_000); // deadline 1,009,000 — later, extends in place
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_009_000 });
  });

  it('is a no-op for an earlier observation while a wait notice is already live', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(9_000); // deadline 1,009,000
    const firstKey = waitToasts()[0]!.key;
    raiseWaitNotice(1_000); // deadline 1,001,000 — earlier, no-op
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.key).toBe(firstKey);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_009_000 });
  });

  it('is a no-op for an EQUAL observation while a wait notice is already live', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(5_000); // deadline 1,005,000
    const firstKey = waitToasts()[0]!.key;
    raiseWaitNotice(5_000); // same deadline exactly — no-op
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.key).toBe(firstKey);
  });

  // Concurrent requests served the same Retry-After land a few ms apart; that is not an extension, and replacing the toast would re-announce the alert once per response.
  it('coalesces a SAME-wait observation a few ms later into the live toast without replacing it', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(30_000); // deadline 1,030,000
    const firstKey = waitToasts()[0]!.key;
    vi.advanceTimersByTime(5);
    raiseWaitNotice(30_000); // deadline 1,030,005 — 5 ms later, NOT an extension
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.key).toBe(firstKey);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_030_000 });
  });

  it('treats a deadline more than the one-second tolerance later as a real extension', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(30_000); // deadline 1,030,000
    const firstKey = waitToasts()[0]!.key;
    raiseWaitNotice(31_001); // deadline 1,031,001 — past the tolerance, extends
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.key).not.toBe(firstKey);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_031_001 });
  });

  it('never stacks a second toast while one is live — always exactly one wait notice', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(1_000);
    raiseWaitNotice(2_000);
    raiseWaitNotice(500);
    raiseWaitNotice(10_000);
    expect(waitToasts()).toHaveLength(1);
  });

  // This API's hour-window throttles (MFA/step-up/change-email, ttl 3_600_000) serve Retry-After values this large on a required sign-in path, so there is no upper ceiling.
  it('raises for an hour-scale Retry-After — there is no upper ceiling on a raisable wait', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(3_600_000); // @nestjs/throttler's 1-hour blockDuration, in ms
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_000_000 + 3_600_000 });
  });

  it('a fresh raise after the live notice closes starts a NEW toast, not an extend of the gone one', () => {
    vi.setSystemTime(1_000_000);
    raiseWaitNotice(5_000);
    const firstKey = waitToasts()[0]!.key;
    appToastQueue.close(firstKey);
    expect(waitToasts()).toHaveLength(0);

    raiseWaitNotice(3_000);
    const toasts = waitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.key).not.toBe(firstKey);
    expect(toasts[0]!.content).toEqual({ kind: 'wait', deadlineAt: 1_003_000 });
  });
});
