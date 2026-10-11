/**
 * Generic modal dialog component.
 *
 * Built on React Aria's `ModalOverlay` / `Modal` / `Dialog`.
 *
 * Behavioral contract (framework-independent, expressed on
 * React Aria — see "Modals" in docs/ui-conventions.md):
 *  - viewport-centered on both axes (horizontally always; vertically in the
 *    default mode — `scrollBodyLabel` anchors to the top instead, so a dialog
 *    whose content grows as you fill it in does not re-centre under you)
 *  - scrim/backdrop click closes (routes through `onClose`) —
 *    `isDismissable` on the overlay; gated by the `dismissable` prop
 *  - Esc closes (routes through `onClose`) — React Aria default; gated
 *    independently by `keyboardDismissable` (defaults to `dismissable`)
 *  - optional Enter handler (`onEnter`) — skips `role="spinbutton"`
 *    controls (React Aria `<DatePicker>` segments / spinner-less
 *    `NumberField`) and legacy native `date`/`number` inputs
 *  - focus is trapped inside the panel and restored to the opener on
 *    close (React Aria `Modal` owns the FocusScope + restore)
 *  - dialog role + aria-modal + labelled by its title (React Aria wires
 *    aria-labelledby from the `slot="title"` heading)
 *  - dirty-guard integration: callers wrap `onClose` with
 *    `useDirtyModalClose`, so the scrim/Esc paths prompt while explicit
 *    Cancel buttons call the unguarded close — unchanged, because
 *    `onOpenChange(false)` is the single close channel this component
 *    exposes.
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
   * Panel width as a Tailwind `max-w-*` token, chosen by content
   * density ("Modals" in docs/ui-conventions.md). Default `xl` = the old 560px
   * multi-section default. The panel is always `w-full` and capped by
   * this token, so it shrinks to the viewport on small screens (the
   * surrounding p-4 gutter replaces the old responsive `w-[90%]`).
   */
  size?: ModalSize;
  onEnter?: () => void;
  /**
   * Whether a scrim/backdrop (outside) click dismisses the modal (routing
   * through `onClose`). Defaults to `true` — the historical behavior. Pass
   * `false` when a stray outside click must not close the dialog: the
   * recovery-key modal (a discarded key can't be re-shown), and the re-auth
   * password prompt (a password-manager popup like Keeper/1Password renders
   * outside the dialog, so clicking it counts as an outside interaction and
   * would otherwise close the prompt mid-entry).
   */
  dismissable?: boolean;
  /**
   * Whether the Esc key dismisses the modal. Defaults to `dismissable`, so a
   * fully-locked modal (`dismissable={false}`) also disables Esc unless this
   * is set. Pass `true` alongside `dismissable={false}` to block only
   * outside-click dismissal while keeping Esc as a keyboard exit (the re-auth
   * password prompt does this — Keeper closes it via outside click, not Esc).
   */
  keyboardDismissable?: boolean;
  /**
   * Opt-in viewport-fit mode for content-dense dialogs. When set, the panel is
   * capped to the viewport height, the title is pinned, and the body becomes a
   * keyboard-focusable scroll region whose accessible name is this string
   * (`role="region"` + `aria-label`, mirroring `TableScroll`) — so the whole
   * dialog always fits a short screen and the clipped content stays reachable.
   *
   * When unset (the default), the dialog keeps the standard contract
   * ("Modals" in docs/ui-conventions.md): the panel sizes to its
   * content and the React Aria overlay scrolls the whole panel once it exceeds
   * the viewport. Only reach for this when a single dialog's content is dense
   * enough to overflow — it is not a global modal behavior change.
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

// Shared panel chrome (both modes).
const PANEL_BASE =
  'w-full rounded-lg border border-line bg-surface-raised p-6 shadow-xl';

// Opt-in viewport-fit panel (`scrollBodyLabel` set). A flex column that can grow
// no taller than its overlay, so the *whole* dialog — title, padding, gutters,
// and any wrapped title lines — always fits on-screen; the title stays pinned
// (`shrink-0`) and only the body scrolls.
//
// `max-h-full`, NOT a `calc()` against `100vh`/`100dvh`. The overlay in this mode
// is sized to React Aria's own `--visual-viewport-height`, so `max-h-full`
// resolves against its CONTENT box — the browser subtracts the `p-4` gutter
// itself, exactly, with no arithmetic to get wrong and no disagreement with RA
// about what the viewport is. Hand-subtracting the gutter is what made this
// fragile:
// land even a sub-pixel over and the overlay becomes scrollable by a hair, and
// any scrollable slack lets the browser's focus scroll-into-view drag the whole
// dialog when a control is activated — which an `overflow-hidden` overlay will
// not let the user drag back. With the panel unable to exceed the content box,
// the overlay's scrollHeight always equals its clientHeight, so there is nothing
// to scroll and the dialog cannot drift.
const PANEL_SCROLL_CLASS = `flex flex-col ${PANEL_BASE} max-h-full`;

// Scrollable body region (opt-in mode). `flex-1 min-h-0` lets it absorb the
// height the pinned title leaves and shrink below its content so
// `overflow-y-auto` engages; it is keyboard-focusable (`tabIndex={0}` + focus
// ring, mirroring `TableScroll`) so content clipped on short viewports stays
// reachable. The `-mx-2 px-2` bleeds the scroll box into the panel padding so
// focus rings on edge-adjacent controls are not clipped by the scroll box.
const BODY_SCROLL_CLASS =
  'min-h-0 flex-1 overflow-y-auto -mx-2 px-2 ' +
  'focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:-outline-offset-2 focus-visible:outline-ring';

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, children, size = 'xl', onEnter, dismissable = true, keyboardDismissable = dismissable, scrollBodyLabel }) => {
  // Opt-in viewport-fit mode: pin the title and scroll only the body so the
  // whole dialog fits a short screen. Default (unset) keeps the standard
  // contract — the panel sizes to content and the overlay scrolls the panel.
  const scrollBody = scrollBodyLabel !== undefined;
  const onEnterRef = useRef(onEnter);

  /**
   * Pin the overlay's scroll offset in viewport-fit mode.
   *
   * The overlay here is a fixed, exactly-viewport-sized scrim whose only child
   * is a panel capped to fit it, so it must never scroll — but `overflow-hidden`
   * only removes the scrollbar; the element stays scrollable PROGRAMMATICALLY.
   * React Aria's `Switch` focuses a visually-hidden `<input>` on toggle, and
   * that input can sit a few px outside the overlay's box, so the browser's
   * focus scroll-into-view scrolls the overlay to "reveal" it — dragging the
   * whole dialog off-screen (observed: overlay scrollTop 1022, panel top
   * -1006). Resetting the offset makes the dialog immovable regardless of which
   * descendant the browser decides to reveal, without suppressing focus.
   */
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

  // Enter-to-submit. React Aria owns Esc + focus trap + restoration +
  // scrim, but not an app-level Enter handler. Keep the historical
  // semantics: Enter inside a plain text field still submits the modal
  // form, but Enter must NOT be stolen from a control that owns the
  // keystroke itself. Guards (early-return, no preventDefault):
  //  - `role="spinbutton"` ancestor: RA DatePicker segment / NumberField
  //  - legacy native `date`/`number` input: defence-in-depth
  //  - focused `<button>`: Enter on a button activates that button
  //    natively (e.g. Enter on Cancel cancels; Enter on Save saves)
  //  - focused `<textarea>`: Enter adds a newline, not a submit
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
    // Modal layer: z-50 (top of the default scale). A confirm prompt
    // opened over a modal still stacks above it — React Aria appends
    // each overlay's portal to <body> at open time, so the later-opened
    // ConfirmDialog (also z-50) wins on DOM order.
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      // The two non-explicit close channels are gated independently: scrim
      // (outside) click via `dismissable`, Esc via `keyboardDismissable`
      // (which defaults to `dismissable`). This lets the re-auth password
      // prompt block outside-click dismissal — a password-manager popup
      // renders outside the dialog, so clicking it would otherwise close it —
      // while keeping Esc as a keyboard exit.
      isDismissable={dismissable}
      isKeyboardDismissDisabled={!keyboardDismissable}
      ref={pinOverlayScroll}
      // In viewport-fit mode the PANEL is already capped to the viewport and its
      // body owns the scrolling, so the overlay must not scroll too — two nested
      // scrollers make the whole dialog jump when the body reaches its end or a
      // toggle reveals a field. The default contract keeps `overflow-y-auto`
      // byte-identical, because a content-sized panel taller than the viewport
      // relies on the overlay to scroll it.
      className={
        scrollBody
          ? // Height comes from React Aria's own `--visual-viewport-height`,
            // which it sets as an inline style on THIS element and keeps in sync
            // with the VISUAL viewport (mobile URL bar, on-screen keyboard). An
            // exactly-sized box is what lets the panel's `max-h-full` resolve to
            // "this content box minus the `p-4` gutter" with no hand arithmetic —
            // `min-h-full` let the box grow with its content, and `100vh`/`100dvh`
            // are the wrong quantity here (they ignore the keyboard and disagree
            // with RA's own measurement). Any slack between the overlay's
            // scrollHeight and clientHeight is what the browser's focus
            // scroll-into-view grabs to drag the dialog off-centre.
            // `items-start`, NOT `items-center`. A vertically CENTRED panel
            // re-centres whenever its height changes, so every toggle that
            // reveals or hides a field visibly jerks the whole dialog by half
            // the height delta — the dialog should stay put while you fill it
            // in. Anchored to the top, growth extends downward until the panel
            // hits `max-h-full` and its body takes over scrolling; the top edge
            // never moves. (The default mode keeps centring: those panels size
            // to content once and do not grow under the user.)
            'fixed inset-0 z-50 flex h-[var(--visual-viewport-height)] items-start justify-center overflow-hidden bg-overlay p-4'
          : 'fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4'
      }
    >
      <RACModal
        className={
          scrollBody
            ? `${PANEL_SCROLL_CLASS} ${MODAL_MAX_W[size]}`
            : // Default contract: byte-identical to the pre-opt-in markup so no
              // other modal's layout or snapshot changes.
              `w-full ${MODAL_MAX_W[size]} rounded-lg border border-line bg-surface-raised p-6 shadow-xl`
        }
      >
        <Dialog
          className={
            scrollBody
              ? 'flex min-h-0 flex-1 flex-col outline-none'
              : 'outline-none'
          }
        >
          {/* React Aria's <Dialog> does not forward an `onKeyDown`
              prop to its DOM node, so the app-level Enter-to-submit
              affordance listens on a wrapper that catches the bubbling
              keydown from the dialog's focusable children. In scroll-body
              mode the wrapper is the flex column that pins the title and
              scrolls only the body, so the panel never exceeds its cap. */}
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
