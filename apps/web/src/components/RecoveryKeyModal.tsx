/**
 * Recovery-key setup / rotation modal; the key is shown once and the saved-key checkbox gates Continue, since losing
 * every unwrapper makes encrypted data unrecoverable. See "Encryption" in docs/security.md.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { Alert } from './Alert';
import { Modal } from './Modal';
import { Muted } from './Muted';
import { btnPrimaryClass, btnSecondaryClass } from './dialog-chrome';

interface RecoveryKeyModalProps {
  recoveryKey: string;
  onConfirmed: () => void;
  onDismiss: () => void;
  /**
   * Dialog title. Default: "Save your recovery key". The props from here to `error` override the
   * first-time-setup copy for the regeneration flow.
   */
  title?: string;
  /** Lead paragraph above the key. Default: the setup "only way back" copy. */
  intro?: React.ReactNode;
  /** Warning Alert body below the key. Default: the setup "we can't recover it" copy. */
  warning?: React.ReactNode;
  /** Saved-key confirmation checkbox label. Default: "I have saved my recovery key". */
  savedLabel?: string;
  /** Primary button label. Default: "Continue". */
  confirmLabel?: string;
  confirmDisabled?: boolean;
  error?: React.ReactNode;
  /**
   * Whether scrim click and Esc dismiss the modal. The regeneration flow passes `false`: the new
   * key cannot be re-shown, so a stray click must not discard it.
   */
  dismissable?: boolean;
}

// Returns `true` only on a real success. An optional-chained `navigator.clipboard?.writeText` would
// resolve without throwing when the API is absent and falsely signal a copy.
async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const RecoveryKeyModal: React.FC<RecoveryKeyModalProps> = ({
  recoveryKey,
  onConfirmed,
  onDismiss,
  title = 'Save your recovery key',
  intro,
  warning,
  savedLabel = 'I have saved my recovery key',
  confirmLabel = 'Continue',
  confirmDisabled = false,
  error,
  dismissable = true,
}) => {
  const [saved, setSaved] = useState(false);
  // Three outcomes: silence on a denied or unavailable clipboard would leave the user believing the
  // key was copied.
  const [copyResult, setCopyResult] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  // A ref so unmounting the modal cancels the pending reset.
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
    };
  }, []);

  // The only clipboard write: a silent write on render would push the key into clipboard managers
  // without the user choosing it.
  const onCopyClick = async (): Promise<void> => {
    const ok = await copyToClipboard(recoveryKey);
    if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
    if (ok) {
      setCopyResult('copied');
      // Only success is transient; the failure message carries the manual-copy instruction and
      // stays until a retry or dismissal.
      copyResetRef.current = setTimeout(() => setCopyResult('idle'), 2000);
    } else {
      setCopyResult('failed');
    }
  };

  return (
    <Modal open onClose={onDismiss} title={title} size="md" dismissable={dismissable}>
      <p className="mt-0 text-sm text-ink">
        {intro ?? (
          <>
            This recovery key is the only way back into your encrypted data if you
            ever forget your password. Forgetting your password alone is enough to
            need it. Store it somewhere safe, separate from your password; a
            password manager is ideal.
          </>
        )}
      </p>
      {error && (
        <Alert tone="error" className="mb-0 mt-3">
          {error}
        </Alert>
      )}
      <Alert tone="warning" className="mb-0 mt-3">
        {warning ?? (
          <>
            We can&apos;t recover it for you, so if you lose both your password and
            this key, your encrypted data is gone for good. No one can read it.
          </>
        )}
      </Alert>

      <div
        className="my-4 rounded-md border border-line-strong bg-surface p-4 font-mono text-sm tracking-wider text-ink"
        data-testid="recovery-key-display"
      >
        {recoveryKey}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" className={btnSecondaryClass} onClick={onCopyClick}>
          Copy recovery key
        </button>
        {/* A polite live region announces the copy result. It stays mounted (empty when idle)
            because screen readers drop content that arrives in the same commit as the region. */}
        <Muted as="span" role="status" className="text-xs">
          {copyResult === 'copied'
            ? 'Copied to clipboard.'
            : copyResult === 'failed'
              ? "Couldn't copy. Please copy the key above manually."
              : ''}
        </Muted>
      </div>

      <Checkbox
        isSelected={saved}
        onChange={setSaved}
        className="group flex cursor-pointer items-start gap-2 text-sm text-ink"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 flex-none items-center justify-center rounded border border-input-line bg-surface text-accent-ink group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2"
        >
          <svg viewBox="0 0 16 16" className="size-3.5 opacity-0 group-data-[selected]:opacity-100" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span>{savedLabel}</span>
      </Checkbox>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          onClick={onConfirmed}
          disabled={!saved || confirmDisabled}
        >
          {confirmLabel}
        </button>
        <button type="button" className={btnSecondaryClass} onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </Modal>
  );
};
