/**
 * Mobile (<lg) navigation drawer — the React Aria overlay that wraps
 * the primary navigation on small viewports.
 *
 * Split out of `App.tsx` to keep that file short. Built on a React
 * Aria `ModalOverlay`/`Modal`, so the drawer genuinely TRAPS focus,
 * closes on Esc, locks body scroll, and RESTORES focus to the opener on
 * close. Route-change auto-close stays the caller's concern (App.tsx
 * flips `isOpen` on `location.pathname`).
 *
 * Desktop (≥lg) does NOT use this component — the sidebar renders
 * statically in the flex shell. A React Aria modal is an ACTIVE focus
 * trap + scroll lock for as long as it is mounted, so it cannot merely
 * be CSS-hidden (`lg:hidden`) at the desktop breakpoint: a viewport
 * resize from mobile-open to desktop would otherwise leave an
 * invisible focus trap / scroll lock over the visible desktop UI.
 * Instead the overlay is only mounted while the mobile media query
 * matches; crossing into desktop unmounts it (releasing the trap and
 * the body-scroll lock) and asks the caller to close. The drawer panel
 * slides in from the left and contains the caller-supplied nav.
 */
import React, { useEffect, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';

// Tailwind `lg` breakpoint (1024px). At/above this the static desktop
// sidebar is shown and this drawer must NOT be an active RA modal.
const DESKTOP_QUERY = '(min-width: 1024px)';

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', handler);
    // Re-sync in case the query changed before the listener attached.
    setIsDesktop(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}

interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** The navigation content (the shared Sidebar in drawer mode). */
  children: React.ReactNode;
}

export const MobileNavDrawer: React.FC<MobileNavDrawerProps> = ({
  isOpen,
  onClose,
  children,
}) => {
  const isDesktop = useIsDesktop();

  // At the desktop breakpoint the static sidebar is shown; never keep
  // an active RA modal (focus trap + scroll lock) mounted there. If the
  // viewport crossed into desktop while the drawer was open, ask the
  // caller to drop its open state so it does not re-trap on a resize
  // back to mobile.
  useEffect(() => {
    if (isDesktop && isOpen) onClose();
  }, [isDesktop, isOpen, onClose]);

  if (isDesktop) return null;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      // Mobile only: this overlay is only mounted below the lg
      // breakpoint (the desktop sidebar renders statically). z-30 keeps
      // it above the sticky mobile top bar (z-10) and page content.
      className="fixed inset-0 z-30 bg-overlay"
    >
      <Modal className="h-full w-64 max-w-full shadow-lg outline-none">
        <Dialog
          aria-label="Primary navigation"
          className="h-full outline-none"
        >
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
