/**
 * The app's single bottom-anchored toast region, mounted once in `App.tsx` so signed-out routes reach it too. Renders
 * the shared queue from `lib/toast-queue.ts`, branching on the content kind (`'version'`, `'wait'`).
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

function descriptionFor(reason: MismatchReason): string {
  if (reason === 'schema-ahead') {
    return 'A newer version of the app is required to read the latest changes — reload to update.';
  }
  return 'A newer version of the app is ready. Reload to pick it up. Your local data stays intact.';
}

// react-aria's `useToast` makes `ToastContent` an atomic live region, so a per-second value inside
// it would re-announce the whole toast every second. The ticking digits are `aria-hidden` and a
// fixed `sr-only` string carries the accessible content.
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
  // Announced once, frozen at mount: `deadlineAt` is fixed per toast, so screen readers get the
  // duration a sighted user sees when the alert fires.
  const [announcedSecondsLeft] = useState(() => secondsUntil(deadlineAt, Date.now()));
  return (
    <Text
      slot="description"
      className="text-sm text-muted"
    >
      {/* Copy is fixed and not paraphrased; at N=1 it reads "1 seconds" by design. */}
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
      // Not a modal, so actions stay right-aligned. `z-[60]` keeps a wait notice raised over an
      // open modal legible and its Close button clickable.
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
        {/* Not RA's `slot="close"`, which forces a queue-only close: Dismiss must go through
            `dismissCurrentMismatch()` so the snooze is persisted. */}
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
