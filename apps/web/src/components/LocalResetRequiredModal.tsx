/**
 * Blocking modal when a cross-user login cannot clear the previous account's local data because another tab holds the
 * IndexedDB open. The login has failed closed, so nothing dismisses it: the user closes the other tabs and retries.
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
   * Re-attempts the IDB drop and login continuation; a still-blocked retry keeps the modal open.
   */
  onRetry: () => Promise<void>;
}

export const LocalResetRequiredModal: React.FC<LocalResetRequiredModalProps> = ({
  open,
  onRetry,
}) => {
  const [retrying, setRetrying] = useState(false);
  // RAC does not auto-wire `aria-describedby` from a description slot (as in ConfirmDialog); wire
  // it so the alertdialog has an accessible description.
  const descId = useId();

  const handleRetry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // On success the parent unmounts this modal; if still blocked the button re-enables.
      setRetrying(false);
    }
  };

  return (
    <ModalOverlay
      isOpen={open}
      // Blocking: no scrim-close and no Esc-close while the guard is failing closed.
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
