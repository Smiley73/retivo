/**
 * Small-screen advisory shown on the sign-in page. Retivo is laid out for tablets and computers; on a phone
 * the pages still open but do not format well, so a phone-width viewport
 * gets a one-time heads-up before signing in.
 *
 *  - Threshold: viewport width below 640px (Tailwind `sm`) — phones only;
 *    portrait tablets (768px+) never see it.
 *  - Dismissal: per tab session (`sessionStorage`). Continue, Esc, and a
 *    scrim click all count — the notice must never nag within one visit,
 *    and comes back the next time the app is opened on the phone.
 *  - Placement: a modal on the sign-in surface only, not on every page.
 *
 * Built on the shared {@link Modal} (React Aria `Dialog`) so
 * the dialog role, focus trap + restore, and Esc/scrim dismiss come from
 * there. The media query is live: rotating a phone into a wider viewport
 * closes the notice without marking it dismissed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { btnPrimaryClass } from './dialog-chrome';

/** Below Tailwind's `sm` breakpoint (640px) — phone-width viewports. */
export const PHONE_VIEWPORT_QUERY = '(max-width: 639px)';

/** sessionStorage key: `'1'` once the notice has been dismissed in this tab. */
export const SMALL_SCREEN_NOTICE_DISMISSED_KEY = 'retivo:small-screen-notice-dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY) === '1';
  } catch {
    // Storage blocked (private mode / policy): treat as not dismissed so
    // the advisory still shows once per mount.
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
    // Re-sync in case the query changed before the listener attached.
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
