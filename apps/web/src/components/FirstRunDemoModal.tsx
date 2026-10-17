/**
 * First-login modal that asks the user whether to load the demo
 * dataset. Triggered by AppShell when sync settles in `synced` state
 * with zero household members in IndexedDB — i.e. a brand-new workspace
 * the user just signed up to.
 *
 * Skipping the modal leaves the user on the Household welcome card
 * where they can add their primary member manually. The Settings →
 * Workspace → "Load demo data" button is the second surface for this
 * loader (with an overwrite warning when data already exists).
 */
import React, { useState } from 'react';
import { Modal } from './Modal';
import { Alert } from './Alert';
import { Muted } from './Muted';
import { btnPrimaryClass, btnSecondaryClass } from './dialog-chrome';
import { DemoDataExistsError, loadDemoData } from '../lib/demo-data-loader';

interface FirstRunDemoModalProps {
  open: boolean;
  householdId: string;
  email: string;
  displayName: string;
  onLoaded(): void;
  onSkip(): void;
}

export const FirstRunDemoModal: React.FC<FirstRunDemoModalProps> = ({
  open,
  householdId,
  email,
  displayName,
  onLoaded,
  onSkip,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await loadDemoData({ householdId, email, displayName });
      onLoaded();
    } catch (err) {
      if (err instanceof DemoDataExistsError) {
        setError(err.message);
      } else {
        setError('Failed to load demo data. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onSkip} title="Try the demo dataset?" size="md">
      <Muted as="p" className="mt-0">
        This looks like a fresh workspace. Load a sample household to see how
        the app works. It comes with accounts, balances, income, expenses,
        scenarios, and Social Security details.
      </Muted>
      <Muted as="p" className="text-xs">
        You can always start from scratch instead by skipping this and adding
        your own primary member on the Household page.
      </Muted>
      {error && (
        <Alert tone="error" className="mt-3 mb-0">
          {error}
        </Alert>
      )}
      {/* Left-aligned, primary (Load demo data) first ("Modals" in docs/ui-conventions.md). */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? 'Loading…' : 'Load demo data'}
        </button>
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={onSkip}
          disabled={submitting}
        >
          Skip
        </button>
      </div>
    </Modal>
  );
};
