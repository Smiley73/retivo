/**
 * Accessible `alertdialog` replacing native `confirm()`: Esc and scrim resolve cancel, Enter confirms, the primary
 * action leads. See "Modals" in docs/ui-conventions.md.
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
  /** Plain string or rich content. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Whether the confirmed action is destructive (red button, the default); `false` uses the primary
   * style so red keeps meaning danger.
   */
  destructive?: boolean;
  /**
   * Leading glyph on the confirm button: trash when destructive, check otherwise; `null` suppresses
   * it.
   */
  confirmIcon?: React.ReactNode;
  /** Panel width token; widen only for multi-paragraph warnings. Defaults to `sm`. */
  size?: ModalSize;
  /**
   * Interactive content between the message and the actions, kept outside the `aria-describedby`
   * message so a control is not nested in the description.
   */
  extraContent?: React.ReactNode;
}

// Controls that own Enter, matched by tag, ARIA role or contenteditable so `extraContent` widgets
// stay scoped.
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
  const resolvedConfirmIcon =
    confirmIcon !== undefined ? confirmIcon : destructive ? <TrashIcon /> : <CheckIcon />;
  const onConfirmRef = useRef(onConfirm);
  // RAC auto-wires `aria-describedby` only for `role="alertdialog"` when none is passed; wire it
  // explicitly so it holds for any role.
  const messageId = useId();

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  // Enter confirms unless an interactive control has focus, so Confirm, Cancel and `extraContent`
  // controls keep their own Enter behaviour.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter') return;
    if (isInteractiveTarget(e.target as HTMLElement)) return;
    e.preventDefault();
    e.stopPropagation();
    onConfirmRef.current();
  };

  return (
    // Same z-50 as Modal: opened later, so its body portal sits later in the DOM and paints on top.
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4"
    >
      <RACModal className={`w-full ${MODAL_MAX_W[size]} rounded-lg border border-line bg-surface-raised p-6 shadow-xl`}>
        <Dialog
          role="alertdialog"
          aria-describedby={messageId}
          className="outline-none"
        >
          {/* React Aria's <Dialog> does not forward `onKeyDown`, so Enter is caught on this
              wrapper. */}
          <div onKeyDown={handleKeyDown}>
            <Heading
              slot="title"
              className="mt-0 mb-3 text-xl font-semibold text-ink"
            >
              {title}
            </Heading>
            <Text
              id={messageId}
              slot="description"
              // RAC's <Text> renders an inline <span>; `block` is needed for the margin to apply.
              className={extraContent ? 'mb-4 block text-muted' : 'mb-6 block text-muted'}
            >
              {message}
            </Text>
            {extraContent ? <div className="mb-6">{extraContent}</div> : null}
            <div className="flex justify-start gap-3">
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  // Focused on open so Enter-to-confirm works: the keydown bubbles to the wrapper.
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
 * Promise-based confirm mirroring the native API:
 * `await confirm('Delete?', 'This cannot be undone.')`.
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
