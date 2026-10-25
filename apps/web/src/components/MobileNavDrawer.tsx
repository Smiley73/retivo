/**
 * Mobile (<lg) navigation drawer on a React Aria `Modal`. Mounted only below the desktop breakpoint, since an RA
 * modal is an active focus trap and scroll lock that cannot merely be CSS-hidden.
 */
import React, { useEffect, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';

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

  // Drop the caller's open state at the desktop breakpoint so it does not re-trap on a resize back
  // to mobile.
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
      // z-30 sits above the sticky mobile top bar (z-10).
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
