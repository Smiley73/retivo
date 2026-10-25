// The SPA's idle-timeout UX: activity resets, warn modal, cross-tab sync, visibility wake and the one-shot signout reason; server enforcement is covered in the api tests.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdleTimer,
  consumeSignoutReason,
  recordProgrammaticActivity,
  setSignoutReason,
  SIGNOUT_REASON_IDLE,
} from './IdleTimer';

const ACTIVITY_KEY = 'retivo.auth.lastActivityAt';

function renderTimer(overrides: { idleMs?: number; warnLeadMs?: number } = {}) {
  const onWarn = vi.fn().mockResolvedValue(undefined);
  const onTimeout = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <IdleTimer
      enabled
      idleMs={overrides.idleMs ?? 30_000}
      warnLeadMs={overrides.warnLeadMs ?? 5_000}
      onWarn={onWarn}
      onTimeout={onTimeout}
    />,
  );
  return { ...utils, onWarn, onTimeout };
}

describe('IdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    clearStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTimeout after idleMs of no activity', async () => {
    const { onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('shows the warn modal at idleMs - warnLeadMs', async () => {
    renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_001);
    });

    expect(screen.getByText(/still there/i)).toBeInTheDocument();
    expect(screen.getByText(/signed out in about/i)).toBeInTheDocument();
  });

  it('"Stay signed in" calls onWarn and resets the timer', async () => {
    const { onWarn, onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_001);
    });

    const stay = screen.getByRole('button', { name: /stay signed in/i });
    await act(async () => {
      fireEvent.click(stay);
      await Promise.resolve();
    });

    expect(onWarn).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('user activity resets the timer', async () => {
    const { onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      fireEvent.mouseDown(window);
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('programmatic activity is handled like an input event: writes the clock and reschedules this tab', async () => {
    const { onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });
    const mounted = localStorage.getItem(ACTIVITY_KEY);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      recordProgrammaticActivity();
    });
    // A bare write would not have rescheduled this tab: the key moved and the 30 s timer was pushed out.
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(String(Date.now()));
    expect(localStorage.getItem(ACTIVITY_KEY)).not.toBe(mounted);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('programmatic activity reaches every mounted timer', async () => {
    const first = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });
    const second = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      recordProgrammaticActivity();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(first.onTimeout).not.toHaveBeenCalled();
    expect(second.onTimeout).not.toHaveBeenCalled();
  });

  it('a timer that unmounted no longer listens for programmatic activity', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderTimer();
    unmount();
    expect(remove.mock.calls.map(([type]) => type)).toContain('retivo:programmatic-activity');
    remove.mockRestore();
  });

  it('programmatic activity does nothing while the timer is disabled', async () => {
    render(<IdleTimer enabled={false} idleMs={30_000} warnLeadMs={5_000} onWarn={vi.fn()} onTimeout={vi.fn()} />);
    recordProgrammaticActivity();
    expect(localStorage.getItem(ACTIVITY_KEY)).toBeNull();
  });

  it('storage event from another tab resets the timer', async () => {
    const { onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(26_000);
    });

    await act(async () => {
      localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ACTIVITY_KEY,
          newValue: String(Date.now()),
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('visibilitychange to visible past idleMs triggers timeout', async () => {
    const { onTimeout } = renderTimer({ idleMs: 30_000, warnLeadMs: 5_000 });

    await act(async () => {
      localStorage.setItem(ACTIVITY_KEY, String(Date.now() - 60_000));
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(onTimeout).toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    const onTimeout = vi.fn();
    const onWarn = vi.fn();
    render(
      <IdleTimer
        enabled={false}
        idleMs={30_000}
        warnLeadMs={5_000}
        onWarn={onWarn}
        onTimeout={onTimeout}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });
});

function clearStorage() {
  // Some test environments ship a localStorage stub without .clear(), so iterate keys.
  for (const store of [localStorage, sessionStorage]) {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key) store.removeItem(key);
    }
  }
}

describe('signout reason helpers', () => {
  beforeEach(() => clearStorage());

  it('round-trips a reason and clears it on consume', () => {
    setSignoutReason(SIGNOUT_REASON_IDLE);
    expect(consumeSignoutReason()).toBe(SIGNOUT_REASON_IDLE);
    expect(consumeSignoutReason()).toBeNull();
  });
});
