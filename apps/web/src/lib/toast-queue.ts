// The app's single toast queue, behind the one region `components/AppToastRegion.tsx` renders: a second region
// would overlap this one at the same screen position. In `lib/` so non-UI modules can raise a wait notice.

import { UNSTABLE_ToastQueue as ToastQueue } from 'react-aria-components';
import type { MismatchReason } from './build-id';

interface VersionToastContent {
  kind: 'version';
  mismatch: string;
  reason: MismatchReason;
}

export interface WaitToastContent {
  kind: 'wait';
  /** Epoch-ms the wait ends; the region ticks its own countdown, this module runs no timer. */
  deadlineAt: number;
}

export type AppToastContent = VersionToastContent | WaitToastContent;

// Default `maxVisibleToasts` (Infinity) is intended: the version prompt and the wait notice must show together.
export const appToastQueue = new ToastQueue<AppToastContent>();

// Module-level, not component state: the raisers run in plain modules, not React components.
let currentWaitKey: string | null = null;
let currentWaitDeadlineAt: number | null = null;

// A further deadline within this tolerance counts as the live notice's own. Concurrent requests served the same `Retry-After`
// differ by a few ms, and replacing the toast each time would re-announce its `role="alert"` and move focus off a keyboard user's Close button.
const WAIT_EXTEND_TOLERANCE_MS = 1_000;

/**
 * Raises the "please wait" notice for a `Retry-After` the caller is about to honor; the sync loop and `POST /auth/refresh` exclude themselves at their call sites.
 * A non-finite or non-positive wait raises nothing. No upper ceiling: the hour-window MFA and step-up throttles serve waits in the thousands of seconds on a required sign-in path.
 * A live notice is extended to a later deadline instead of stacking a second toast; an earlier or tolerance-close one is a no-op.
 */
export function raiseWaitNotice(waitMs: number): void {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return;
  const deadlineAt = Date.now() + waitMs;
  if (currentWaitKey !== null) {
    if (
      currentWaitDeadlineAt !== null &&
      deadlineAt <= currentWaitDeadlineAt + WAIT_EXTEND_TOLERANCE_MS
    ) {
      return;
    }
    appToastQueue.close(currentWaitKey);
  }
  const key = appToastQueue.add(
    { kind: 'wait', deadlineAt },
    {
      // Every close path (countdown, Dismiss, coalescing replace) must clear which toast is live.
      onClose: () => {
        if (currentWaitKey === key) {
          currentWaitKey = null;
          currentWaitDeadlineAt = null;
        }
      },
    },
  );
  currentWaitKey = key;
  currentWaitDeadlineAt = deadlineAt;
}
