/**
 * One-time sign-in advisory for phone-width viewports (below 640px), dismissed per tab session. The media query is
 * live, so rotating wider closes it without marking it dismissed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { btnPrimaryClass } from './dialog-chrome';

const PHONE_VIEWPORT_QUERY = '(max-width: 639px)';

const SMALL_SCREEN_NOTICE_DISMISSED_KEY = 'retivo:small-screen-notice-dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY) === '1';
  } catch {
    // Storage blocked: treat as not dismissed.
    return false;
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: local state still hides it for this mount.
  }
}

function useIsPhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(PHONE_VIEWPORT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsPhone(e.matches);
    mql.addEventListener('change', handler);
    setIsPhone(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isPhone;
}

export const SmallScreenNotice: React.FC = () => {
  const isPhone = useIsPhoneViewport();
  const [dismissed, setDismissed] = useState(readDismissed);

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  if (!isPhone || dismissed) return null;

  return (
    <Modal open onClose={dismiss} title="Best on a larger screen" size="sm">
      <p className="m-0 text-sm text-muted">
        Retivo works best on a tablet or computer. Some pages may not display
        properly on a phone.
      </p>
      <div className="mt-4">
        <button type="button" className={btnPrimaryClass} onClick={dismiss}>
          Continue
        </button>
      </div>
    </Modal>
  );
};
