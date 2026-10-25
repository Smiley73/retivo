/**
 * Generic modal on React Aria `ModalOverlay` / `Modal` / `Dialog`; see "Modals" in docs/ui-conventions.md.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import {
  Dialog,
  Heading,
  Modal as RACModal,
  ModalOverlay,
} from 'react-aria-components';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /**
   * Panel width as a Tailwind `max-w-*` token, chosen by content density; the panel shrinks to the
   * viewport on small screens.
   */
  size?: ModalSize;
  onEnter?: () => void;
  /**
   * Whether an outside click dismisses the modal. Pass `false` where a stray click must not close
   * it: the recovery-key modal, and the re-auth prompt, where a password-manager popup renders
   * outside the dialog.
   */
  dismissable?: boolean;
  /**
   * Whether Esc dismisses the modal. Defaults to `dismissable`; pass `true` with
   * `dismissable={false}` to keep Esc as the only exit.
   */
  keyboardDismissable?: boolean;
  /**
   * Viewport-fit mode for content-dense dialogs: the panel is capped to the viewport height, the
   * title is pinned, and the body becomes a keyboard-focusable scroll region named by this string.
   * Unset, the panel sizes to its content and the overlay scrolls it.
   */
  scrollBodyLabel?: string;
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';

export const MODAL_MAX_W: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
};

const PANEL_BASE =
  'w-full rounded-lg border border-line bg-surface-raised p-6 shadow-xl';

// Capped to the overlay's content box: `max-h-full` leaves no slack for focus scroll-into-view to
// drag the dialog.
const PANEL_SCROLL_CLASS = `flex flex-col ${PANEL_BASE} max-h-full`;

// `-mx-2 px-2` keeps focus rings on edge-adjacent controls from being clipped by the scroll box.
const BODY_SCROLL_CLASS =
  'min-h-0 flex-1 overflow-y-auto -mx-2 px-2 ' +
  'focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:-outline-offset-2 focus-visible:outline-ring';

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, children, size = 'xl', onEnter, dismissable = true, keyboardDismissable = dismissable, scrollBodyLabel }) => {
  const scrollBody = scrollBodyLabel !== undefined;
  const onEnterRef = useRef(onEnter);

  // The overlay must never scroll in this mode, but `overflow-hidden` leaves it programmatically
  // scrollable. React Aria's `Switch` focuses a hidden input that can sit outside the overlay box,
  // and the browser would scroll the overlay to reveal it.
  const pinOverlayScroll = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !scrollBody) return;
      const reset = () => {
        if (node.scrollTop !== 0) node.scrollTop = 0;
        if (node.scrollLeft !== 0) node.scrollLeft = 0;
      };
      node.addEventListener('scroll', reset, { passive: true });
      reset();
    },
    [scrollBody],
  );

  useEffect(() => {
    onEnterRef.current = onEnter;
  }, [onEnter]);

  // React Aria's Dialog does not forward `onKeyDown`, so Enter is caught on the wrapper below.
  // Spinbutton, button, textarea and native date/number controls own Enter and are skipped.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || !onEnterRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest('[role="spinbutton"]')) return;
    if (target.tagName === 'INPUT') {
      const type = target.getAttribute('type');
      if (type === 'date' || type === 'number') return;
    }
    if (target.tagName === 'BUTTON') return;
    if (target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    e.stopPropagation();
    onEnterRef.current();
  };

  return (
    // A later-opened overlay (a ConfirmDialog over a modal) wins on DOM order at the same z-index.
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      // Outside click and Esc are gated separately: a password-manager popup renders outside the
      // dialog.
      isDismissable={dismissable}
      isKeyboardDismissDisabled={!keyboardDismissable}
      ref={pinOverlayScroll}
      // In viewport-fit mode the body scrolls, so the overlay must not.
      className={
        scrollBody
          ? // Sized to React Aria's `--visual-viewport-height` so the panel's `max-h-full` resolves against the visual viewport.
            // `items-start` so a growing dialog does not re-centre under the user.
            'fixed inset-0 z-50 flex h-[var(--visual-viewport-height)] items-start justify-center overflow-hidden bg-overlay p-4'
          : 'fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4'
      }
    >
      <RACModal
        className={
          scrollBody
            ? `${PANEL_SCROLL_CLASS} ${MODAL_MAX_W[size]}`
            : `w-full ${MODAL_MAX_W[size]} rounded-lg border border-line bg-surface-raised p-6 shadow-xl`
        }
      >
        <Dialog
          className={
            scrollBody
              ? 'flex min-h-0 flex-1 flex-col outline-none'
              : 'outline-none'
          }
        >
          <div
            onKeyDown={handleKeyDown}
            className={scrollBody ? 'flex min-h-0 flex-1 flex-col' : undefined}
          >
            <Heading
              slot="title"
              className={`mt-0 mb-3 text-xl font-semibold text-ink${scrollBody ? ' shrink-0' : ''}`}
            >
              {title}
            </Heading>
            {scrollBody ? (
              <div
                className={BODY_SCROLL_CLASS}
                role="region"
                aria-label={scrollBodyLabel}
                tabIndex={0}
              >
                {children}
              </div>
            ) : (
              children
            )}
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
};
