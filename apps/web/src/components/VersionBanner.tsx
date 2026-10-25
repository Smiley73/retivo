/**
 * Build-id mismatch subscriber feeding the shared toast queue (rendered by `AppToastRegion.tsx`); mounted in
 * `AppShell`, not `App.tsx`, so signed-out visitors never see it.
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
          currentKey = appToastQueue.add({
            kind: 'version',
            mismatch: mismatch.buildId,
            reason: mismatch.reason,
          });
          currentReason = mismatch.reason;
        } else if (currentReason !== mismatch.reason) {
          // Same build id with a stronger reason (schema-ahead): replace so the copy updates.
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
