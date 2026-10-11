/**
 * Blocking modal shown when a cross-user login cannot clear the previous
 * account's local data because another browser tab still holds the IndexedDB
 * open (the cross-user IndexedDB-leak guard fails closed).
 *
 * The login has failed closed: the new account's claims/household are NOT
 * exposed, so there is no safe way to dismiss this — the user must close the
 * other tabs (which releases their IDB handle; the dropping tab nudges them via
 * BroadcastChannel) and then Retry. Built on React Aria's `ModalOverlay` /
 * `Modal` / `Dialog` with dismissal disabled
 * (`isDismissable={false}` + `isKeyboardDismissDisabled`) so neither the scrim,
 * Esc, nor an X can bypass the guard.
 */
import React, { useId, useState } from 'react';
import {
  Dialog,
  Heading,
  Modal as RACModal,
  ModalOverlay,
  Text,
} from 'react-aria-components';
import { btnPrimaryClass } from './dialog-chrome';

interface LocalResetRequiredModalProps {
  open: boolean;
  /**
   * Re-attempt the cross-user IDB drop + login continuation. May reject /
   * re-block; the component shows a spinner while it runs and surfaces nothing
   * itself — a still-blocked retry simply keeps this modal open.
   */
  onRetry: () => Promise<void>;
}

export const LocalResetRequiredModal: React.FC<LocalResetRequiredModalProps> = ({
  open,
  onRetry,
}) => {
  const [retrying, setRetrying] = useState(false);
  // RAC's `Dialog` auto-wires `aria-labelledby` from the `slot="title"`
  // heading but does NOT auto-wire `aria-describedby` from a description
  // slot (matches ConfirmDialog.tsx). Wire it explicitly so the alertdialog
  // has a programmatic accessible description, not just a title.
  const descId = useId();

  const handleRetry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // If the retry succeeded the parent unmounts this modal; if it stayed
      // blocked the modal remains open and the button re-enables for another go.
      setRetrying(false);
    }
  };

  return (
    <ModalOverlay
      isOpen={open}
      // Blocking: no scrim-close, no Esc-close. The login is in a fail-closed
      // state until the previous account's IDB is actually dropped.
      isDismissable={false}
      isKeyboardDismissDisabled
      className="fixed inset-0 z-50 flex min-h-full items-center justify-center overflow-y-auto bg-overlay p-4"
    >
      <RACModal className="w-full max-w-md rounded-lg border border-line bg-surface-raised p-6 shadow-xl">
        <Dialog
          role="alertdialog"
          aria-describedby={descId}
          className="outline-none"
        >
          <Heading
            slot="title"
            className="mt-0 mb-3 text-xl font-semibold text-ink"
          >
            Close all other tabs to continue
          </Heading>
          <Text
            id={descId}
            slot="description"
            className="mb-6 block text-muted"
          >
            Another browser tab still has this app open, so we couldn&rsquo;t
            clear the previous account&rsquo;s data from this device. Close all
            other tabs for this site, then click Retry. We won&rsquo;t sign you
            in until the old data is cleared.
          </Text>
          <div className="flex justify-start gap-3">
            <button
              type="button"
              autoFocus
              className={btnPrimaryClass}
              onClick={() => void handleRetry()}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
};
