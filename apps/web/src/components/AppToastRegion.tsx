/**
 * The app's single bottom-anchored toast region. Mounted once in
 * `App.tsx`, above the routed subtree, so every route
 * reaches it — including the signed-out auth routes (`/login`, `/signup`,
 * `/auth/request-password-reset`, `/auth/reset-password`) that sit outside
 * `AppShell`/`RequireAuth`.
 *
 * Renders the ONE shared queue from `lib/toast-queue.ts`, branching on the
 * content kind:
 *   - `'version'` — the build-mismatch reload prompt (Dismiss →
 *     `dismissCurrentMismatch()`, `data-testid="version-banner"`).
 *     `VersionBanner` owns the build-id subscription and enqueues/closes
 *     into the shared queue; it renders no region of its own.
 *   - `'wait'` — the "Please wait N seconds before trying again." notice a
 *     non-sync `Retry-After` observation raises (`raiseWaitNotice`).
 *
 * Rendered at `fixed bottom-4 right-4 …` — a second region would place two
 * absolutely-positioned stacks at the same coordinates. `z-[60]`: a wait notice can raise while a `Modal`/`PasswordManagerModal`/
 * `ConfirmDialog` overlay is open (`z-50`, e.g. a throttled step-up
 * verification), and the region must sit above that overlay or the notice
 * is both visually washed out by the scrim and unreachable — the scrim
 * intercepts every pointer event below it, including the toast's own Close
 * button.
 */
import React, { useEffect, useState } from 'react';
import {
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastRegion as ToastRegion,
  type QueuedToast,
} from 'react-aria-components';
import { appToastQueue, type AppToastContent } from '../lib/toast-queue';
import { dismissCurrentMismatch, type MismatchReason } from '../lib/build-id';
import { secondsUntil } from '../sync/badge-format';

/**
 * Copy variants (shared with `VersionBanner.tsx`, which feeds the
 * toast queue). `schema-ahead` is the stronger signal — the current
 * bundle truly cannot read a pulled row, not just "a newer build exists" —
 * so it gets its own, more urgent description. Both share the same title,
 * Dismiss, and Reload actions.
 */
function descriptionFor(reason: MismatchReason): string {
  if (reason === 'schema-ahead') {
    return 'A newer version of the app is required to read the latest changes — reload to update.';
  }
  return 'A newer version of the app is ready. Reload to pick it up. Your local data stays intact.';
}

/**
 * The live per-second countdown for a wait toast. One timer per notice,
 * started on mount and cleared on close/unmount; closes the toast itself
 * once the deadline passes (it disappears at zero or when the user closes
 * it).
 *
 * Accessibility hazard: react-aria's
 * `useToast` puts `role="alert" aria-atomic="true"` on `ToastContent` — an
 * implicit, atomic live region. A visible value that changes every second
 * inside it would re-announce the WHOLE toast every second for the length of
 * the wait. Mirrors `SyncBadge.tsx`'s "Retrying in Ns" countdown: the
 * ticking digits are `aria-hidden` (excluded from the accessible tree, so
 * their mutation is never picked up as a live-region change) and a separate,
 * unchanging `sr-only` string carries the accessible content instead — it
 * only changes when the toast is added/removed, never once a second.
 */
function WaitToastDescription({
  toastKey,
  deadlineAt,
}: {
  toastKey: string;
  deadlineAt: number;
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadlineAt]);
  const secondsLeft = secondsUntil(deadlineAt, now);
  useEffect(() => {
    if (secondsLeft <= 0) appToastQueue.close(toastKey);
  }, [secondsLeft, toastKey]);
  // Announced ONCE, at mount, from the seconds remaining at that instant —
  // frozen for the toast's whole life rather than recomputed per tick.
  // `deadlineAt` is fixed for a given toast (a coalescing
  // extension closes this toast and mounts a fresh one with a new
  // `toastKey`), so a `useState` initializer keyed on nothing is correct:
  // this component instance never needs a second value. Screen readers get
  // the same duration a sighted user sees at the moment the alert fires,
  // rather than an open-ended "wait" with no number.
  const [announcedSecondsLeft] = useState(() => secondsUntil(deadlineAt, Date.now()));
  return (
    <Text
      slot="description"
      className="text-sm text-muted"
    >
      {/* Copy is fixed: "Please wait N seconds before
          trying again." — not paraphrased, no retry button, nothing
          disabled. At N=1 this literally reads "1 seconds"; there is
          deliberately no singular form. */}
      <span aria-hidden="true">
        Please wait <span aria-hidden="true">{secondsLeft}</span> seconds before trying again.
      </span>
      <span className="sr-only">
        Please wait {announcedSecondsLeft} seconds before trying again.
      </span>
    </Text>
  );
}

export const AppToastRegion: React.FC = () => {
  return (
    <ToastRegion
      queue={appToastQueue}
      // Fixed bottom-right (NOT a modal — the modal left-primary action
      // rule deliberately does not apply to an off-modal notification;
      // actions stay right-aligned). Position unchanged from the old
      // VersionBanner-owned region. z-[60]: above the z-50 modal/dialog
      // overlay scrim, so a wait notice raised while a modal (e.g. StepUp)
      // is open stays legible and its Close button stays clickable.
      // eslint-disable-next-line no-restricted-syntax -- irreducible: default scale tops out at z-50 (Modal/ConfirmDialog/PasswordManagerModal's own overlay), and this region must stack above every one of them
      className="fixed bottom-4 right-4 left-auto z-[60] flex flex-col gap-2 outline-none max-sm:left-2 max-sm:right-2 max-sm:bottom-2"
    >
      {({ toast }) => <AppToast toast={toast} />}
    </ToastRegion>
  );
};

function AppToast({
  toast,
}: {
  toast: QueuedToast<AppToastContent>;
}): React.ReactElement {
  if (toast.content.kind === 'wait') {
    return (
      <Toast
        toast={toast}
        data-testid="wait-notice"
        className="flex max-w-sm flex-col gap-2 rounded-lg border border-line bg-surface-raised p-3 px-4 shadow-lg outline-none max-sm:max-w-none"
      >
        <ToastContent className="flex flex-col gap-1">
          <WaitToastDescription
            toastKey={toast.key}
            deadlineAt={toast.content.deadlineAt}
          />
        </ToastContent>
        <div className="flex justify-end">
          <Button
            slot="close"
            className="inline-flex items-center rounded-md border border-line-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-accent-link outline-none transition-colors hover:bg-surface-sunken data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
          >
            Close
          </Button>
        </div>
      </Toast>
    );
  }

  const version = toast.content;
  return (
    <Toast
      toast={toast}
      data-testid="version-banner"
      className="flex max-w-sm flex-col gap-2 rounded-lg border border-line bg-surface-raised p-3 px-4 shadow-lg outline-none max-sm:max-w-none"
    >
      <ToastContent className="flex flex-col gap-1">
        <Text
          slot="title"
          className="font-semibold text-ink"
        >
          New version available
        </Text>
        <Text
          slot="description"
          className="text-sm text-muted"
        >
          {descriptionFor(version.reason)}
        </Text>
      </ToastContent>
      <div className="flex justify-end gap-2">
        {/* Not RA's `slot="close"` — that would force aria-label="Close"
            and a queue-only close. Dismiss must route through
            `dismissCurrentMismatch()` so the snooze is persisted in
            sessionStorage (build-id.ts); the build-id subscription (still
            in VersionBanner.tsx) then removes the toast. */}
        <Button
          className="inline-flex items-center rounded-md border border-line-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-accent-link outline-none transition-colors hover:bg-surface-sunken data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
          onPress={() => dismissCurrentMismatch()}
        >
          Dismiss
        </Button>
        <Button
          className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink shadow-sm outline-none transition-colors hover:bg-accent/90 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
          onPress={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </Toast>
  );
}
