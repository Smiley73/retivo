/**
 * Dirty-state guards: `useUnsavedChangesGuard` (navigation), `useDirtyModalClose` (X / Esc / scrim) and
 * `useDirtyDiscardAction` (any discarding action). See "Modals" and "Form controls" in docs/ui-conventions.md.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Modal } from './Modal';
import { btnDangerClass, btnSecondaryClass } from './dialog-chrome';

interface StayLeaveModalProps {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}

const StayLeaveModal: React.FC<StayLeaveModalProps> = ({ open, onStay, onLeave }) => (
  <Modal open={open} onClose={onStay} title="Unsaved changes" size="md">
    <p className="mt-0 text-ink">
      You have unsaved changes. Leave without saving?
    </p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className={btnDangerClass} onClick={onLeave}>
        Leave
      </button>
      <button type="button" className={btnSecondaryClass} onClick={onStay}>
        Stay
      </button>
    </div>
  </Modal>
);

export interface UnsavedChangesGuardResult {
  /** Render this somewhere in the page tree (typically alongside the page's other modals). */
  pendingNavModal: React.ReactNode;
  /** Navigates without prompting, for explicit Cancel / Discard buttons. */
  navigateUnguarded: (to: string) => void;
}

/**
 * Page-level guard, active only while `isDirty`: `beforeunload` for tab close, and a Stay / Leave
 * modal for in-app navigation that changes the pathname. Leave re-issues `navigate(target)` through
 * an "allow next" ref.
 */
export function useUnsavedChangesGuard(isDirty: boolean): UnsavedChangesGuardResult {
  const navigate = useNavigate();
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  // Set just before re-issuing a blocked navigation so the patched `pushState` lets it through.
  const allowNextNavRef = useRef(false);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Patches `pushState` / `replaceState` because the app runs on `BrowserRouter`, where
  // `useBlocker` is unavailable.
  useEffect(() => {
    if (!isDirty) return;
    const originalPush = window.history.pushState.bind(window.history);
    const originalReplace = window.history.replaceState.bind(window.history);

    const shouldIntercept = (urlArg: unknown): string | null => {
      if (allowNextNavRef.current) {
        allowNextNavRef.current = false;
        return null;
      }
      if (typeof urlArg !== 'string' && !(urlArg instanceof URL)) return null;
      const target = new URL(String(urlArg), window.location.origin);
      if (target.pathname === window.location.pathname) return null;
      return target.pathname + target.search + target.hash;
    };

    window.history.pushState = function (data, unused, url) {
      const blocked = url == null ? null : shouldIntercept(url);
      if (blocked !== null) {
        setPendingNav(blocked);
        return;
      }
      return originalPush(data, unused, url ?? null);
    } as typeof window.history.pushState;

    window.history.replaceState = function (data, unused, url) {
      const blocked = url == null ? null : shouldIntercept(url);
      if (blocked !== null) {
        setPendingNav(blocked);
        return;
      }
      return originalReplace(data, unused, url ?? null);
    } as typeof window.history.replaceState;

    return () => {
      window.history.pushState = originalPush;
      window.history.replaceState = originalReplace;
    };
  }, [isDirty]);

  const onStay = useCallback(() => setPendingNav(null), []);
  const onLeave = useCallback(() => {
    if (!pendingNav) return;
    const target = pendingNav;
    setPendingNav(null);
    allowNextNavRef.current = true;
    navigate(target);
  }, [pendingNav, navigate]);

  const navigateUnguarded = useCallback((to: string) => {
    allowNextNavRef.current = true;
    navigate(to);
  }, [navigate]);

  const pendingNavModal = (
    <StayLeaveModal open={pendingNav !== null} onStay={onStay} onLeave={onLeave} />
  );

  return { pendingNavModal, navigateUnguarded };
}

export interface DirtyModalCloseResult {
  /** Wrap a Modal's `onClose` with this — prompts when dirty, calls `realClose` when clean. */
  guardedClose: () => void;
  /** Bypass the prompt and close immediately — wire this to explicit Cancel buttons. */
  immediateClose: () => void;
  /** Render this alongside the modal it guards. */
  confirmModal: React.ReactNode;
}

/**
 * Modal-level close-path guard, active only while `isDirty`. Wire `guardedClose` to the Modal's
 * `onClose` and `immediateClose` to explicit Cancel and save paths.
 */
export function useDirtyModalClose(isDirty: boolean, realClose: () => void): DirtyModalCloseResult {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const guardedClose = useCallback(() => {
    if (isDirty) {
      setConfirmOpen(true);
      return;
    }
    realClose();
  }, [isDirty, realClose]);

  const immediateClose = useCallback(() => {
    setConfirmOpen(false);
    realClose();
  }, [realClose]);

  const onStay = useCallback(() => setConfirmOpen(false), []);
  const onLeave = useCallback(() => {
    setConfirmOpen(false);
    realClose();
  }, [realClose]);

  const confirmModal = <StayLeaveModal open={confirmOpen} onStay={onStay} onLeave={onLeave} />;

  return { guardedClose, immediateClose, confirmModal };
}

export interface DirtyDiscardActionResult {
  /** Runs `action` immediately when clean, after a Stay / Leave confirm when dirty. */
  runGuarded: (action: () => void) => void;
  /** Render this alongside the modal it guards. */
  confirmModal: React.ReactNode;
}

/**
 * Guards an in-app action that would discard a dirty draft, reusing the Stay / Leave prompt of
 * `useDirtyModalClose`.
 */
export function useDirtyDiscardAction(isDirty: boolean): DirtyDiscardActionResult {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const runGuarded = useCallback(
    (action: () => void) => {
      if (!isDirty) {
        action();
        return;
      }
      // Arrow wrapper so React stores the action as a value, not an updater.
      setPendingAction(() => action);
    },
    [isDirty],
  );

  const onStay = useCallback(() => setPendingAction(null), []);
  const onLeave = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }, [pendingAction]);

  const confirmModal = (
    <StayLeaveModal open={pendingAction !== null} onStay={onStay} onLeave={onLeave} />
  );

  return { runGuarded, confirmModal };
}
