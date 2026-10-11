/**
 * Reusable hooks that implement the "Guard unsaved edits against accidental
 * loss" rule from CODING_STANDARDS.md ("UI guards") and the project-specific
 * implementation pattern in docs/ui-conventions.md ("Modals" and "Form controls").
 *
 * Two related but distinct concerns:
 *
 * - `useUnsavedChangesGuard(isDirty)` — page-level navigation guard. Listens
 *   for `beforeunload` and patches `window.history.pushState` /
 *   `replaceState` so sidebar `<Link>` clicks and programmatic
 *   `navigate(...)` calls get intercepted before the URL changes. Renders a
 *   styled Stay / Leave modal that the caller drops into its tree.
 *
 * - `useDirtyModalClose(isDirty, realClose)` — modal-level close-path
 *   guard. Wraps the Modal's `onClose` so the X button, Esc key, and scrim
 *   click prompt before discarding edits. **Explicit Cancel buttons inside
 *   the modal call `realClose` directly** — those are intentional discards
 *   per CODING_STANDARDS.md. Returns the wrapped close, the unguarded close,
 *   and the confirm modal for the caller to render alongside.
 *
 * - `useDirtyDiscardAction(isDirty)` — guards an arbitrary in-app action that
 *   would discard the draft (e.g. an in-modal `<Link>`/`navigate(...)` that
 *   unmounts a dirty explicit-Save surface). Runs the action immediately when
 *   clean; when dirty it shows the SAME Stay/Leave prompt as
 *   `useDirtyModalClose` and runs the action only after the user picks Leave.
 *   `useDirtyModalClose` covers only X / Esc / scrim — not in-app navigation.
 *
 * Why a `pushState` patch instead of react-router's `useBlocker`: the app
 * runs on `BrowserRouter`, not a data router (`createBrowserRouter`), and
 * `useBlocker` only works under the latter. `<Link>` clicks and
 * `useNavigate()` both ultimately call `window.history.pushState`, so
 * patching it covers every same-app navigation path.
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
    {/* Left-aligned, primary (Leave — the affirmative for this prompt)
        first ("Modals" in docs/ui-conventions.md). Styled with Tailwind
        defaults. */}
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
  /**
   * Navigate to `to` without prompting, even when dirty. Wire this to explicit
   * Cancel / Discard buttons on full-page forms so an intentional user action
   * doesn't double-confirm. Mirrors `immediateClose` from useDirtyModalClose
   * for the page case.
   */
  navigateUnguarded: (to: string) => void;
}

/**
 * Page-level guard. Activates only while `isDirty === true`.
 *
 * - Tab close / reload: triggers the browser's native `beforeunload` confirm.
 * - In-app navigation: blocks pathname changes via `pushState` / `replaceState`,
 *   stashes the target in state, and surfaces a Stay / Leave modal. Stay
 *   leaves the URL untouched; Leave re-issues `navigate(target)` with an
 *   internal "allow next" ref so the patched `pushState` lets that one
 *   call through. Query / hash changes pass through untouched.
 */
export function useUnsavedChangesGuard(isDirty: boolean): UnsavedChangesGuardResult {
  const navigate = useNavigate();
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  // Set to true just before we re-issue the navigation we previously blocked,
  // so the patched pushState lets that one through without re-prompting.
  const allowNextNavRef = useRef(false);

  // beforeunload — handles tab close / reload while dirty.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // pushState / replaceState patch — intercepts in-app navigation.
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
 * Modal-level close-path guard. Activates only while `isDirty === true`.
 *
 * Wire `guardedClose` to the Modal's `onClose` prop (which the Modal calls
 * for X button, Esc key, and scrim click). Wire `immediateClose` to any
 * explicit Cancel button inside the modal — those are intentional discards
 * and bypass the prompt per CODING_STANDARDS.md.
 *
 * Save paths should also call `immediateClose` (or however the modal closes
 * after a successful save) — there's nothing to lose post-save.
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
  /**
   * Run `action` guarded by the dirty check: immediately when clean, after a
   * Stay/Leave confirm when dirty. Wire this to in-app navigations (e.g. a
   * `<Link>`/`navigate(...)` that unmounts the dirty modal) so they prompt
   * before discarding the draft.
   */
  runGuarded: (action: () => void) => void;
  /** Render this alongside the modal it guards. */
  confirmModal: React.ReactNode;
}

/**
 * Guards an arbitrary in-app action that would discard a dirty draft.
 * Activates only while `isDirty === true`; when clean the action runs straight
 * through. Reuses the same `StayLeaveModal` as `useDirtyModalClose` so the copy
 * and behavior match the X / Esc / scrim close paths.
 */
export function useDirtyDiscardAction(isDirty: boolean): DirtyDiscardActionResult {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const runGuarded = useCallback(
    (action: () => void) => {
      if (!isDirty) {
        action();
        return;
      }
      // Store the action behind the prompt. Wrap in an arrow so React's state
      // setter treats it as a value, not an updater function.
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
