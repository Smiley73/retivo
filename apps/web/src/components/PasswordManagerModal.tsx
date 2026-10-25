/**
 * Containment-free dialog for password-entry surfaces; see "Password managers" in docs/ui-conventions.md.
 */
import React, { useEffect, useRef } from 'react';
import { Dialog, Heading } from 'react-aria-components';
import { MODAL_MAX_W, type ModalSize } from './Modal';

interface PasswordManagerModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Panel width as a Tailwind `max-w-*` token. */
  size?: ModalSize;
  /**
   * Suppresses the Escape-to-`onClose` path while set, e.g. during a verify in flight; the scrim
   * always blocks outside clicks.
   */
  keyboardDismissDisabled?: boolean;
  children: React.ReactNode;
}

// Ref-counted so a stacked instance (the dirty-guard confirm over a Change-password modal) does not
// unlock the body until the last locker unmounts.
let scrollLockCount = 0;

function lockBodyScroll(): void {
  scrollLockCount += 1;
  if (scrollLockCount === 1) {
    document.body.style.overflow = 'hidden';
  }
}

function unlockBodyScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = '';
  }
}

const FOCUSABLE = 'input, select, textarea, button, a[href], [tabindex]';

// Skips negatively tab-indexed, `aria-hidden` and `type="hidden"` elements programmatically: the
// `:not([tabindex="-1"])` CSS guard would still match the `tabIndex={-1}` HiddenUsernameField input
// and steal autofocus.
function focusFirstIn(root: HTMLElement): void {
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
    (el) =>
      el.tabIndex >= 0 &&
      el.getAttribute('aria-hidden') !== 'true' &&
      (el as HTMLInputElement).type !== 'hidden',
  );
  (focusable ?? root).focus();
}

/**
 * Renders nothing when closed. Deliberately not wrapped in RAC `Modal` / `ModalOverlay`: their
 * `ariaHideOutside` inert and focus containment freeze a password manager's autofill popup, which
 * renders outside the dialog, and no public prop disables them. A standalone `<Dialog>` has no
 * focus trap, scroll lock or Escape handling, so those are hand-rolled here; re-verify that it
 * stays free of inert and focus-contain on a react-aria bump.
 */
export const PasswordManagerModal: React.FC<PasswordManagerModalProps> = ({
  open,
  onClose,
  title,
  size = 'xl',
  keyboardDismissDisabled = false,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  // Refs so the single open-lifecycle effect reads the latest handler without re-running and
  // re-capturing focus.
  const onCloseRef = useRef(onClose);
  const keyboardDismissDisabledRef = useRef(keyboardDismissDisabled);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    keyboardDismissDisabledRef.current = keyboardDismissDisabled;
  }, [keyboardDismissDisabled]);

  // Captured during render: by the time effects run, the child `<Dialog>`'s autofocus has already
  // moved `activeElement` off the opener.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    triggerRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpenRef.current = open;

  // Cleanup also runs on unmount-while-open, so an abnormal unmount cannot leak the scroll lock or
  // captured focus.
  useEffect(() => {
    if (!open) return;

    lockBodyScroll();
    if (panelRef.current) focusFirstIn(panelRef.current);

    // Standalone `<Dialog>` does not handle Escape. Enter is never intercepted, so form submission
    // and password-manager fill-and-submit work.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (keyboardDismissDisabledRef.current) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      unlockBodyScroll();
      // Fall back to the body when the trigger has left the DOM.
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) {
        trigger.focus();
      } else {
        document.body.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    // z-50 like Modal so a ConfirmDialog opened over this still wins on DOM order. The scrim
    // swallows `pointerDown` and `click` so an outside interaction, such as a password-manager
    // popup, never dismisses the prompt.
    <div
      className="fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <Dialog
        ref={panelRef}
        className={`w-full ${MODAL_MAX_W[size]} rounded-lg border border-line bg-surface-raised p-6 shadow-xl outline-none`}
      >
        <Heading
          slot="title"
          className="mt-0 mb-3 text-xl font-semibold text-ink"
        >
          {title}
        </Heading>
        {children}
      </Dialog>
    </div>
  );
};
