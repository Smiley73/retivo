/**
 * Build-id mismatch subscriber (a fresh deploy shipped while this tab was
 * open). Feeds the shared app-wide toast queue in
 * `apps/web/src/lib/toast-queue.ts`; the actual toast markup and the one
 * bottom-anchored region it renders into live in
 * `apps/web/src/components/AppToastRegion.tsx` (the region is shared so a
 * second wait-notice toast kind does not need a second absolutely-
 * positioned region at the same screen coordinates).
 *
 * This component renders no DOM of its own — it only subscribes and calls
 * `appToastQueue.add`/`close`. It is mounted inside
 * `AppShell` (the authenticated shell): the REGION sits in `App.tsx` so the
 * public auth routes have a toast surface, but moving this
 * SUBSCRIBER up too would start showing "New version
 * available" to signed-out visitors.
 *
 * The build-id machinery: it subscribes to the detector
 * in apps/web/src/lib/build-id.ts (fed by every API response via
 * api/client.ts + sync/sync-client.ts), so the toast appears within seconds
 * of the next interaction with no dedicated polling; the two-step
 * verification gate, the `sessionStorage` dismiss-snooze, and the
 * schema-ahead force-clear all live in build-id.ts and are untouched here.
 *
 * Copy branches on the mismatch's `reason` —
 * `descriptionFor` lives in `AppToastRegion.tsx` alongside the rendering
 * it feeds.
 */
import { useEffect } from 'react';
import type { FC } from 'react';
import { appToastQueue } from '../lib/toast-queue';
import {
  getCurrentMismatch,
  subscribeToVersionMismatch,
  type MismatchReason,
  type VersionMismatch,
} from '../lib/build-id';

export const VersionBanner: FC = () => {
  useEffect(() => {
    let currentKey: string | null = null;
    let currentReason: MismatchReason | null = null;
    const sync = (mismatch: VersionMismatch | null): void => {
      if (mismatch) {
        if (currentKey === null) {
          // Persistent: no `timeout` — a reload prompt never auto-hides.
          currentKey = appToastQueue.add({
            kind: 'version',
            mismatch: mismatch.buildId,
            reason: mismatch.reason,
          });
          currentReason = mismatch.reason;
        } else if (currentReason !== mismatch.reason) {
          // Same build id, stronger reason arrived (e.g. schema-ahead
          // after a plain build-mismatch) — replace so the copy updates.
          appToastQueue.close(currentKey);
          currentKey = appToastQueue.add({
            kind: 'version',
            mismatch: mismatch.buildId,
            reason: mismatch.reason,
          });
          currentReason = mismatch.reason;
        }
      } else if (currentKey !== null) {
        appToastQueue.close(currentKey);
        currentKey = null;
        currentReason = null;
      }
    };
    sync(getCurrentMismatch());
    const unsub = subscribeToVersionMismatch(sync);
    return () => {
      unsub();
      if (currentKey !== null) {
        appToastQueue.close(currentKey);
        currentKey = null;
      }
    };
  }, []);

  return null;
};
