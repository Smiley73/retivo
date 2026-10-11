/**
 * Accessible confirmation dialog component.
 *
 * Replaces native `confirm()` which is not accessible to screen readers.
 * Built on React Aria's `ModalOverlay` / `Modal` / `Dialog`, with
 * Tailwind v4 state-variant styling.
 *
 * Behavioral contract (see "Modals" in docs/ui-conventions.md):
 *  - viewport-centered on both axes
 *  - Esc + scrim/backdrop click resolve `false` (cancel) — React Aria's
 *    single `onOpenChange(false)` channel is mapped to `onCancel`
 *  - Enter resolves `true` (confirm)
 *  - focus trapped + restored to the opener on close (React Aria Modal)
 *  - `role="alertdialog"` + aria-modal + labelled/described by title +
 *    message
 *  - action row is LEFT-aligned with the PRIMARY (confirm) action FIRST
 *    (do not reintroduce flex-end / Cancel-first)
 *  - width matched to content per the modal width scale (one short
 *    sentence + two buttons → max-w-sm)
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Dialog,
  Heading,
  Modal as RACModal,
  ModalOverlay,
  Text,
} from 'react-aria-components';
import { btnDangerClass, btnPrimaryClass, btnSecondaryClass } from './dialog-chrome';
import { MODAL_MAX_W, type ModalSize } from './Modal';
import { KbdHint } from './KbdHint';
import { CheckIcon, TrashIcon } from './icons';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Plain string or rich content (e.g. <strong> for emphasis on irreversible warnings). */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Whether the confirmed action is destructive (delete/overwrite/wipe).
   * Defaults to `true` so every existing call site keeps its red danger
   * button unchanged. Pass `false` for benign confirmations (a "did you
   * mean to also do X?" flow prompt) so the confirm action uses the lime
   * primary style — otherwise a screen full of red buttons stops the red
   * from meaning "danger". See the Profile/settings critique.
   */
  destructive?: boolean;
  /**
   * Leading glyph on the confirm button. Omit to auto-pick by intent — a
   * trash icon for destructive confirms, a check for benign ones — so every
   * confirm reads consistently. Pass an explicit icon for a destructive action
   * that is not a delete (e.g. a reload/restore), or `null` to suppress.
   */
  confirmIcon?: React.ReactNode;
  /**
   * Panel width as a Tailwind `max-w-*` token (modal width scale in
   * docs/ui-conventions.md). Defaults to `sm` — the one-short-sentence + two-button
   * confirm size. Widen only when the warning runs to multiple
   * paragraphs (e.g. the restore-snapshot confirm).
   */
  size?: ModalSize;
  /**
   * Optional interactive content rendered BETWEEN the message and the action
   * row — e.g. an extra opt-in checkbox on a destructive confirm (the
   * "Delete workspace data" flow's "Also erase backup history" toggle). Kept OUTSIDE
   * the `aria-describedby` message `<Text>` so an interactive control is not
   * nested inside the dialog's accessible description.
   */
  extraContent?: React.ReactNode;
}

/**
 * Interactive controls whose own Enter/keyboard handling must NOT be
 * hijacked by the dialog's Enter-to-confirm affordance. Guarded by
 * tag AND ARIA role/`contenteditable` so both native controls and
 * `role`-annotated widgets reachable via `extraContent` (checkbox / switch /
 * radio / textbox …) stay scoped when focused. Enter on any of these — or on
 * the Confirm/Cancel buttons — must fire the control's own behaviour, never
 * the destructive confirm.
 */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'BUTTON',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'A',
]);
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'switch',
  'radio',
  'textbox',
  'combobox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'link',
]);

function isInteractiveTarget(target: HTMLElement): boolean {
  if (INTERACTIVE_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  return role !== null && INTERACTIVE_ROLES.has(role);
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  destructive = true,
  confirmIcon,
  size = 'sm',
  extraContent,
}) => {
  // Auto-pick the confirm glyph by intent unless the caller passed one
  // (including an explicit `null` to suppress). Destructive → trash, benign → check.
  const resolvedConfirmIcon =
    confirmIcon !== undefined ? confirmIcon : destructive ? <TrashIcon /> : <CheckIcon />;
  const onConfirmRef = useRef(onConfirm);
  // RAC's `Dialog` auto-wires `aria-labelledby` from the `slot="title"`
  // heading. Since react-aria 3.51 it ALSO auto-wires `aria-describedby`
  // from `slot="description"` — but only for `role="alertdialog"` and only
  // when the caller passes none. Keep wiring it explicitly: it takes
  // precedence, holds for any role, and is what the accessible-description
  // test pins (regression vs the prior Headless-UI `<Description>`).
  const messageId = useId();

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  // React Aria owns Esc + scrim (→ onOpenChange(false) → onCancel) +
  // focus trap/restore. Enter-to-confirm is an app-level affordance
  // React Aria doesn't provide. Interactive-target guard: if the Enter
  // target is a focused interactive control, return early so Enter stays
  // scoped to that control (Enter on Confirm/Cancel fires the button's own
  // click; Enter on a form control the control handles itself). Only Enter
  // on the NON-interactive dialog body triggers the confirm affordance.
  // Broadened beyond `<button>` so an `extraContent` control — e.g.
  // the "Delete workspace data" flow's "Also erase backup history" React Aria
  // Checkbox — never fires the destructive confirm while it has focus.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter') return;
    if (isInteractiveTarget(e.target as HTMLElement)) return;
    e.preventDefault();
    e.stopPropagation();
    onConfirmRef.current();
  };

  return (
    // Same z-50 as Modal: a confirm prompt is opened *after* any modal
    // it sits over, so React Aria's per-overlay body portal puts it
    // later in the DOM and it paints on top without a higher z-index.
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4"
    >
      {/* `sm` (≈ the old 400px) is the default confirm-dialog size:
          one short sentence + a two-button row ("Modals" in docs/ui-conventions.md).
          Callers widen via `size` for multi-paragraph warnings. */}
      <RACModal className={`w-full ${MODAL_MAX_W[size]} rounded-lg border border-line bg-surface-raised p-6 shadow-xl`}>
        <Dialog
          role="alertdialog"
          aria-describedby={messageId}
          className="outline-none"
        >
          {/* React Aria's <Dialog> does not forward an `onKeyDown` prop
              to its DOM node, so Enter-to-confirm listens on a wrapper
              that catches the bubbling keydown from the dialog's
              focusable children. */}
          <div onKeyDown={handleKeyDown}>
            <Heading
              slot="title"
              className="mt-0 mb-3 text-xl font-semibold text-ink"
            >
              {title}
            </Heading>
            {/* The message is the dialog's accessible description,
                wired explicitly via `aria-describedby={messageId}` on
                the <Dialog> above, which takes precedence over RAC's own
                slot wiring. `<Text slot="description">` still renders the
                <p> and keeps rich/multiline children working. */}
            <Text
              id={messageId}
              slot="description"
              // RAC's <Text> renders an inline <span>; `block` is required
              // for the bottom margin to take effect (margin-bottom is a
              // no-op on inline elements) and to give the message/button
              // gap below. Tighten the gap when `extraContent` follows so the
              // opt-in control reads as part of the same prompt.
              className={extraContent ? 'mb-4 block text-muted' : 'mb-6 block text-muted'}
            >
              {message}
            </Text>
            {/* Interactive opt-in content (e.g. an extra checkbox), kept out of
                the aria-describedby message above. */}
            {extraContent ? <div className="mb-6">{extraContent}</div> : null}
            {/* Left-aligned, primary (confirm) action FIRST ("Modals" in docs/ui-conventions.md). */}
            <div className="flex justify-start gap-3">
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  // Focus the primary action on open (parity with the
                  // prior build, which relied on the dialog focusing its
                  // first focusable). Keeps Enter-to-confirm working —
                  // the keydown bubbles up to the wrapper handler.
                  autoFocus
                  className={`${destructive ? btnDangerClass : btnPrimaryClass} gap-1.5`}
                  onClick={onConfirm}
                >
                  {resolvedConfirmIcon}
                  {confirmLabel}
                </button>
                <KbdHint>Enter</KbdHint>
              </div>
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  className={btnSecondaryClass}
                  onClick={onCancel}
                >
                  {cancelLabel}
                </button>
                <KbdHint>Esc</KbdHint>
              </div>
            </div>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
};

/**
 * Hook-based confirm that returns a promise, mirroring the native API.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm('Delete?', 'This cannot be undone.');
 */
export function useConfirm() {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    message: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    confirmIcon?: React.ReactNode;
  } | null>(null);

  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const resolvedRef = useRef(false);

  const confirm = (title: string, message: React.ReactNode, options?: { confirmLabel?: string; cancelLabel?: string; destructive?: boolean; confirmIcon?: React.ReactNode }): Promise<boolean> => {
    resolvedRef.current = false;
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ open: true, title, message, confirmLabel: options?.confirmLabel, cancelLabel: options?.cancelLabel, destructive: options?.destructive, confirmIcon: options?.confirmIcon });
    });
  };

  const handleConfirm = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    resolveRef.current?.(true);
    resolveRef.current = null;
    setState(null);
  }, []);

  const handleCancel = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    resolveRef.current?.(false);
    resolveRef.current = null;
    setState(null);
  }, []);

  const dialog = state ? (
    <ConfirmDialog
      open={state.open}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel ?? 'Delete'}
      cancelLabel={state.cancelLabel ?? 'Cancel'}
      destructive={state.destructive ?? true}
      confirmIcon={state.confirmIcon}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, dialog };
}
