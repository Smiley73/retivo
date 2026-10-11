/**
 * Tests for AppToastRegion — the one shared bottom-anchored toast region
 * Both toast kinds are enqueued directly
 * against the shared `appToastQueue` (VersionBanner's own subscription is
 * tested separately in VersionBanner.test.tsx; the raisers that feed the
 * `'wait'` kind are tested at their own call sites).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppToastRegion } from './AppToastRegion';
import { appToastQueue, raiseWaitNotice } from '../lib/toast-queue';
import { expectNoA11yViolations } from '../test/a11y';

/** Clear any toast a test left live so it can't leak into the next one —
 *  the queue is a module-level singleton. */
afterEach(() => {
  for (const t of appToastQueue.visibleToasts) appToastQueue.close(t.key);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AppToastRegion — one region, both kinds', () => {
  it('renders exactly one toast region even with a version toast and a wait notice live at once', () => {
    appToastQueue.add({ kind: 'version', mismatch: 'build-2', reason: 'build-mismatch' });
    raiseWaitNotice(5_000);
    render(<AppToastRegion />);

    // The visual-collision regression this whole lift exists to prevent:
    // assert on the COUNT of regions, not merely that both toasts appear
    // somewhere.
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getByTestId('version-banner')).toBeInTheDocument();
    expect(screen.getByTestId('wait-notice')).toBeInTheDocument();
  });

  it('renders nothing when the queue is empty', () => {
    render(<AppToastRegion />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('AppToastRegion — wait notice countdown and dismissal', () => {
  it('counts down live and removes itself at zero', async () => {
    // Fake timers BEFORE render (SyncContext.test.tsx discipline) so the
    // component's mount-armed interval is a fake timer this test drives.
    vi.useFakeTimers();
    try {
      raiseWaitNotice(3_000);
      render(<AppToastRegion />);
      const notice = screen.getByTestId('wait-notice');
      expect(notice.textContent).toContain('3');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByTestId('wait-notice').textContent).toContain('2');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByTestId('wait-notice').textContent).toContain('1');

      // The final tick crosses the deadline — the notice removes itself.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.queryByTestId('wait-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing removes the notice immediately and stops its timer', async () => {
    vi.useFakeTimers();
    try {
      raiseWaitNotice(10_000);
      render(<AppToastRegion />);
      expect(screen.getByTestId('wait-notice')).toBeInTheDocument();

      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
      fireEvent.click(screen.getByRole('button', { name: /close/i }));

      expect(screen.queryByTestId('wait-notice')).toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalled();

      // No further ticking now that the timer is torn down — advancing
      // time must not resurrect the notice or throw.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.queryByTestId('wait-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its interval on unmount', () => {
    vi.useFakeTimers();
    try {
      raiseWaitNotice(5_000);
      const { unmount } = render(<AppToastRegion />);
      const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
      unmount();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the ticking digits are aria-hidden — the accessible content does not change once per tick', async () => {
    vi.useFakeTimers();
    try {
      raiseWaitNotice(5_000);
      render(<AppToastRegion />);
      const notice = screen.getByTestId('wait-notice');
      const srOnly = notice.querySelector('.sr-only');
      expect(srOnly).not.toBeNull();
      const srTextBefore = srOnly!.textContent;

      const digitsSpan = Array.from(notice.querySelectorAll('span[aria-hidden="true"]')).find(
        (el) => /^\d+$/.test(el.textContent ?? ''),
      );
      expect(digitsSpan).toBeDefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      // The sr-only accessible text is unaffected by the per-second tick —
      // only the aria-hidden digits change.
      expect(notice.querySelector('.sr-only')!.textContent).toBe(srTextBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AppToastRegion — coalescing', () => {
  it('a later Retry-After observation extends the SAME notice rather than stacking a second toast', () => {
    vi.useFakeTimers();
    try {
      raiseWaitNotice(3_000);
      render(<AppToastRegion />);
      expect(screen.getAllByTestId('wait-notice')).toHaveLength(1);

      raiseWaitNotice(9_000);
      expect(screen.getAllByTestId('wait-notice')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 3.experience.1: N concurrent requests served the SAME Retry-After land a
  // few ms apart. Each must coalesce into the live toast WITHOUT replacing
  // it — a close+re-add mounts a fresh `role="alert"` (re-announced in full
  // once per response) and re-targets a keyboard user who was on Close. So
  // the assertion is DOM-node identity, not merely "one toast exists".
  it('a same-wait observation a few ms later leaves the live toast node untouched', async () => {
    vi.useFakeTimers();
    try {
      raiseWaitNotice(30_000);
      render(<AppToastRegion />);
      const before = screen.getByTestId('wait-notice');
      expect(before.textContent).toContain('30');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      act(() => {
        raiseWaitNotice(30_000);
      });

      const after = screen.getAllByTestId('wait-notice');
      expect(after).toHaveLength(1);
      expect(after[0]).toBe(before);
      expect(after[0]!.textContent).toContain('30');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AppToastRegion — focus and blocking', () => {
  it('raising the wait notice does not move focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    raiseWaitNotice(5_000);
    render(<AppToastRegion />);
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('AppToastRegion — accessibility', () => {
  it('has no a11y violations with both toast kinds rendered', async () => {
    appToastQueue.add({ kind: 'version', mismatch: 'build-2', reason: 'build-mismatch' });
    raiseWaitNotice(5_000);
    const { baseElement } = render(<AppToastRegion />);
    await expectNoA11yViolations(baseElement);
  });
});
