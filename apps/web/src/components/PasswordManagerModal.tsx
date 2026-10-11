/**
 * Password-manager-friendly modal overlay (see "Password managers" in
 * docs/ui-conventions.md).
 *
 * A deliberately containment-FREE dialog for all password-entry surfaces
 * (`PasswordPromptModal`, Profile's Change-password modal, and AccountCard's
 * Change-email modal). It composes React Aria's `<Dialog>` + `<Heading slot="title">`
 * primitive — so `role="dialog"` + `aria-labelledby` are auto-wired and NO
 * `aria-modal` is emitted — but it does NOT wrap that primitive in RAC's
 * `<Modal>`/`<ModalOverlay>`. That wrapper is the sole source of
 * `ariaHideOutside([modalRef], { shouldUseInert: true })` (which marks
 * outside DOM `inert`, including a MutationObserver that auto-inerts injected
 * nodes) plus `FocusScope contain`. Both freeze a browser password manager's
 * injected autofill popup (Keeper / 1Password render it OUTSIDE the dialog),
 * so the popup becomes unclickable and the prompt hangs. Forgoing the OOTB
 * `<Modal>`/`<ModalOverlay>` construction is a deliberate deviation from
 * the framework-defaults-first rule — no public RAC prop disables the
 * inert behavior.
 *
 * Verified against react-aria-components 1.20.0 + react-aria 3.51.0: a
 * standalone `<Dialog>` runs `useDialog`, which sets `role='dialog'`, no
 * `aria-modal`, and calls `useOverlayFocusContain()` — a no-op without an
 * `<Overlay>`/`<ModalOverlay>` context (it reads a null `OverlayContext` and
 * never sets `contain`). So standalone there is no focus trap, no
 * `usePreventScroll`, no `ariaHideOutside`, and no Escape handling. This
 * component therefore hand-rolls the non-primitive shell: a fixed scrim that
 * blocks + swallows page pointer interaction, ref-counted body scroll-lock,
 * autofocus, focus-restore, and a document-level Escape listener.
 *
 * react-aria internals assumption (re-verify on any react-aria bump): that
 * the standalone `<Dialog>` path stays free of `ariaHideOutside`/inert and
 * focus-contain. If a future version moves those into `useDialog`, this
 * composition stops being password-manager-friendly.
 */
import React, { useEffect, useRef } from 'react';
import { Dialog, Heading } from 'react-aria-components';
import { MODAL_MAX_W, type ModalSize } from './Modal';

interface PasswordManagerModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Panel width as a Tailwind `max-w-*` token (the modal width scale in docs/ui-conventions.md). */
  size?: ModalSize;
  /**
   * Suppresses the document-level Escape→`onClose` path while set (e.g. the
   * re-auth prompt blocks Esc while a verify is in flight). The scrim always
   * blocks outside-click dismissal regardless. Defaults to `false` (Esc closes).
   */
  keyboardDismissDisabled?: boolean;
  children: React.ReactNode;
}

// Module-level scroll-lock ref-count: stacked instances (the dirty-guard
// confirm can mount over the Change-password modal) must not unlock the body
// until the LAST locker unmounts. Lock on 0→1, unlock on 1→0.
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

/**
 * First keyboard-focusable element inside `root`, or `root` itself. The
 * `:not([tabindex="-1"])` CSS guard only binds the bare `[tabindex]` token, so
 * a `tabIndex={-1}` `<input>` (the `HiddenUsernameField` every caller renders
 * before the visible password field) would still match `input` and steal
 * autofocus. Filter programmatically instead: skip anything negatively
 * tab-indexed, `aria-hidden`, or `type="hidden"`.
 */
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
 * The containment-free overlay. Renders nothing when closed. The panel chrome
 * (size token, raised surface, border, shadow) mirrors the general `<Modal>`
 * so all password-entry surfaces look identical to every other dialog.
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
  // Refs so the single open-lifecycle effect reads the latest handler / gate
  // without re-running (which would re-capture focus + re-toggle the lock).
  const onCloseRef = useRef(onClose);
  const keyboardDismissDisabledRef = useRef(keyboardDismissDisabled);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    keyboardDismissDisabledRef.current = keyboardDismissDisabled;
  }, [keyboardDismissDisabled]);

  // Capture the trigger during the render phase, on the closed→open transition.
  // This must NOT happen in the open effect: parent effects run after the RAC
  // `<Dialog>` child's autofocus, so by then `document.activeElement` is the
  // panel, not the element that opened us. Reading it in render (before any
  // effect fires) captures the real opener for focus-restore on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    triggerRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpenRef.current = open;

  // Single open-lifecycle effect. Cleanup runs on close AND on
  // unmount-while-open, so an abnormal unmount (route change, parent re-render)
  // cannot leak the scroll-lock or the captured focus.
  useEffect(() => {
    if (!open) return;

    lockBodyScroll();
    if (panelRef.current) focusFirstIn(panelRef.current);

    // Document-level Escape — the standalone `<Dialog>` does not handle it, so
    // there is no double-close to reconcile. Never intercepts Enter (native
    // form submission + password-manager fill-and-submit must work).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (keyboardDismissDisabledRef.current) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      unlockBodyScroll();
      // Restore focus to the captured trigger only if it is still in the DOM;
      // otherwise fall back to the body (the detached-trigger path
      // React Aria handled for free).
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
    // Fixed full-screen scrim. `z-50` matches the general Modal's overlay so a
    // ConfirmDialog opened over this (the dirty-guard stay/leave prompt) still
    // stacks above — React Aria appends its overlay portal to <body> at open
    // time, winning on DOM order. The scrim swallows BOTH `pointerDown` and
    // `click` so an outside interaction never dismisses the prompt (a
    // password-manager popup rendered outside the dialog counts as one); it is
    // NOT a button and routes no `onClose`.
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
