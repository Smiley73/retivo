/**
 * The app's single toast queue. Backs the
 * ONE bottom-anchored toast region the app renders
 * (`components/AppToastRegion.tsx`) — `VersionBanner.tsx` used to own its own
 * `ToastQueue` + `ToastRegion` pair; that queue is now this shared one
 * (`VersionBanner` still enqueues into it, it just no longer renders the
 * region itself), and the wait-notice raisers below feed the same queue with
 * a second content kind. Standing up a second queue/region for the wait
 * notice would place two absolutely-positioned stacks at the same screen
 * coordinates — they would overlap, not stack.
 *
 * Lives under `lib/` (not `components/`) so `lib/account-export-client.ts`
 * and `lib/server-data-export.ts` can import `raiseWaitNotice` without
 * tripping `.dependency-cruiser.cjs`'s `lib-independent-of-ui` rule: that
 * rule bans `lib/**` from importing `components/`/`pages/` MODULE paths, not
 * the `react-aria-components` package itself.
 *
 * Nothing UI-framework-shaped lives here beyond the queue: no React, no
 * rendering — just the union content type, the singleton queue, and the
 * wait-notice raise entry point.
 */
import { UNSTABLE_ToastQueue as ToastQueue } from 'react-aria-components';
import type { MismatchReason } from './build-id';

/** The build-mismatch reload prompt (relocated from `VersionBanner.tsx`,
 *  copy/behaviour unchanged). Not exported — nothing outside this module
 *  needs it standalone; consumers use it through the `AppToastContent`
 *  union. */
interface VersionToastContent {
  kind: 'version';
  /** The server build id that triggered the prompt (toast identity). */
  mismatch: string;
  /** Which copy variant to render — see `descriptionFor` in
   *  `AppToastRegion.tsx`. */
  reason: MismatchReason;
}

/** The "please wait" notice a non-sync `Retry-After` observation raises. */
export interface WaitToastContent {
  kind: 'wait';
  /** Epoch-ms the wait ends. The region ticks its own visible countdown
   *  from this; the queue module never runs a timer itself. */
  deadlineAt: number;
}

export type AppToastContent = VersionToastContent | WaitToastContent;

/** The one app-wide toast queue. Default `maxVisibleToasts` (Infinity) is
 *  intentional — the version prompt and the wait notice must both be able
 *  to show at once, stacked in the one region. */
export const appToastQueue = new ToastQueue<AppToastContent>();

/** Key + deadline of the currently-live wait toast, or `null` when none is
 *  live. Module-level (not component state): the raisers below are called
 *  from plain modules (`api/client.ts`, `lib/server-data-export.ts`,
 *  `lib/account-export-client.ts`), never from a React component. */
let currentWaitKey: string | null = null;
let currentWaitDeadlineAt: number | null = null;

/**
 * How much LATER than the live notice's deadline a further observation must
 * land before it counts as an extension (3.experience.1). The region renders
 * the countdown at one-second granularity and `Retry-After` itself is
 * whole seconds, so a deadline inside this window is indistinguishable on
 * screen from the one already showing. Without it, N concurrent requests
 * all served the SAME `Retry-After` — the normal case under a shared
 * concurrency ceiling — arrive a few ms apart, compute deadlines that differ
 * by those few ms, and each one would close-and-re-add the toast: a fresh
 * `role="alert"` per response (re-announced in full N times), the visible
 * digits jumping back up a second, and a keyboard user mid-region losing
 * the Close button they were on.
 */
const WAIT_EXTEND_TOLERANCE_MS = 1_000;

/**
 * Raise the "please wait" notice for a `Retry-After` the caller is about to
 * honor — everywhere except the sync loop (badge-only) and
 * `POST /auth/refresh` (both excluded at their own call sites, not
 * here). `waitMs` is the raw wait the server asked for.
 *
 * - A non-finite or non-positive wait (absent, unparseable, or already
 *   elapsed) raises nothing — there is nothing to wait for.
 * - There is NO upper ceiling: every non-sync
 *   observation raises with no cutoff, and this API's own
 *   hour-window throttles (MFA/step-up/change-email `ttl: 3_600_000`)
 *   really do serve `Retry-After` in the thousands of seconds on a
 *   required sign-in path — dropping those would leave the user with no
 *   notice at all exactly when the wait is longest. Whether the client
 *   RETRIES on a long wait is a separate, per-caller decision
 *   (`account-export-client.ts` only raises for a served wait it is about
 *   to honor; `retry-backoff.ts` owns that cap); this module only reports
 *   the wait the server asked for.
 * - While a wait notice is already live, a further observation only
 *   EXTENDS it to the LATER of the two deadlines rather than stacking a
 *   second toast: concurrent throttled requests are the normal case under
 *   a shared concurrency ceiling, and N stacked identical notices would be
 *   noise. A deadline that is earlier, equal, or later by no more than
 *   `WAIT_EXTEND_TOLERANCE_MS` is a no-op — the live notice already covers
 *   it, and replacing it would re-announce the whole toast.
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
      // Fires whether the toast closes by the region's own zero-countdown
      // close, the user's Dismiss, or the coalescing replace above — every
      // path must clear this module's notion of "which toast is live" so
      // the next raise doesn't try to extend an already-gone toast.
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
