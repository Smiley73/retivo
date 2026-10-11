/**
 * Client-side idle-session timeout. Server-side enforcement is the source
 * of truth (the refresh-token row's `expiresAt` is checked on every rotate);
 * this component is the UX layer — warns the user before logout and
 * proactively triggers logout so the SPA doesn't sit on stale state.
 *
 * See "Sessions" in docs/security.md for the full policy.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { btnPrimaryClass, btnSecondaryClass } from '../components/dialog-chrome';

const ACTIVITY_KEY = 'retivo.auth.lastActivityAt';
const SIGNOUT_REASON_KEY = 'retivo.auth.signoutReason';
export const SIGNOUT_REASON_IDLE = 'idle-timeout';
export const SIGNOUT_REASON_DEVICE_MISMATCH = 'device-mismatch';

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart'] as const;

interface IdleTimerProps {
  enabled: boolean;
  idleMs: number;
  warnLeadMs: number;
  onWarn: () => Promise<void> | void;
  onTimeout: () => Promise<void> | void;
}

interface IdleTimerHandle {
  recordActivity: () => void;
}

/**
 * Read activity timestamp shared across tabs. The `storage` event lets a
 * tab observe writes from sibling tabs, so any tab with input keeps every
 * other tab's countdown alive.
 */
function readLastActivityAt(): number {
  if (typeof localStorage === 'undefined') return Date.now();
  const raw = localStorage.getItem(ACTIVITY_KEY);
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : Date.now();
}

export function writeLastActivityAt(now: number): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ACTIVITY_KEY, String(now));
}

/**
 * Imperative idle tracker. Hosted by AuthContext; consumes refresh and
 * logout via the props so it stays decoupled from auth internals.
 */
export const IdleTimer = React.forwardRef<IdleTimerHandle, IdleTimerProps>(
  function IdleTimer({ enabled, idleMs, warnLeadMs, onWarn, onTimeout }, ref) {
    const [warnVisible, setWarnVisible] = useState(false);
    const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onWarnRef = useRef(onWarn);
    const onTimeoutRef = useRef(onTimeout);

    useEffect(() => {
      onWarnRef.current = onWarn;
      onTimeoutRef.current = onTimeout;
    }, [onWarn, onTimeout]);

    const clearTimers = useCallback(() => {
      if (warnTimerRef.current) {
        clearTimeout(warnTimerRef.current);
        warnTimerRef.current = null;
      }
      if (timeoutTimerRef.current) {
        clearTimeout(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }
    }, []);

    const scheduleFromActivity = useCallback(() => {
      clearTimers();
      const last = readLastActivityAt();
      const elapsed = Date.now() - last;
      const remaining = idleMs - elapsed;
      if (remaining <= 0) {
        // Already past the window — fire immediately.
        timeoutTimerRef.current = setTimeout(() => {
          void onTimeoutRef.current();
        }, 0);
        return;
      }
      const warnIn = Math.max(0, remaining - warnLeadMs);
      warnTimerRef.current = setTimeout(() => {
        setWarnVisible(true);
        void onWarnRef.current();
      }, warnIn);
      timeoutTimerRef.current = setTimeout(() => {
        setWarnVisible(false);
        void onTimeoutRef.current();
      }, remaining);
    }, [clearTimers, idleMs, warnLeadMs]);

    const recordActivity = useCallback(() => {
      if (!enabled) return;
      writeLastActivityAt(Date.now());
      setWarnVisible(false);
      scheduleFromActivity();
    }, [enabled, scheduleFromActivity]);

    // Expose recordActivity to AuthContext so a successful refresh from
    // the warn modal can bump the clock without faking an input event.
    React.useImperativeHandle(ref, () => ({ recordActivity }), [recordActivity]);

    useEffect(() => {
      if (!enabled) {
        clearTimers();
        setWarnVisible(false);
        return;
      }

      // Seed activity on mount so the first window starts now (unless a
      // sibling tab already wrote a fresher value).
      const last = readLastActivityAt();
      if (Date.now() - last > idleMs) {
        // Boot-after-idle: fire timeout immediately. AuthContext's boot
        // guard usually catches this first, but defending here keeps the
        // semantics correct if the timer starts late.
        void onTimeoutRef.current();
        return;
      }

      writeLastActivityAt(Date.now());
      scheduleFromActivity();

      const onActivity = () => {
        writeLastActivityAt(Date.now());
        scheduleFromActivity();
      };

      const onStorage = (e: StorageEvent) => {
        if (e.key !== ACTIVITY_KEY) return;
        // Activity in another tab — reset our timer without writing back.
        clearTimers();
        setWarnVisible(false);
        scheduleFromActivity();
      };

      const onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        const lastVis = readLastActivityAt();
        const elapsed = Date.now() - lastVis;
        if (elapsed >= idleMs) {
          void onTimeoutRef.current();
          return;
        }
        if (elapsed >= idleMs - warnLeadMs) {
          setWarnVisible(true);
        }
        scheduleFromActivity();
      };

      for (const evt of ACTIVITY_EVENTS) {
        window.addEventListener(evt, onActivity, { passive: true });
      }
      window.addEventListener('storage', onStorage);
      document.addEventListener('visibilitychange', onVisibility);

      return () => {
        clearTimers();
        for (const evt of ACTIVITY_EVENTS) {
          window.removeEventListener(evt, onActivity);
        }
        window.removeEventListener('storage', onStorage);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }, [enabled, idleMs, warnLeadMs, scheduleFromActivity, clearTimers]);

    const minutesLeftLabel = useMemo(() => {
      const minutes = Math.max(1, Math.round(warnLeadMs / 60_000));
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }, [warnLeadMs]);

    if (!enabled) return null;

    return (
      <Modal
        open={warnVisible}
        onClose={() => setWarnVisible(false)}
        title="Still there?"
      >
        <p>
          You&rsquo;ll be signed out in about {minutesLeftLabel} due to
          inactivity.
        </p>
        {/* Modal action row — left-aligned, primary action first
            ("Modals" in docs/ui-conventions.md). */}
        <div className="mt-4 flex flex-wrap items-center justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={async () => {
              setWarnVisible(false);
              await onWarnRef.current();
              recordActivity();
            }}
          >
            Stay signed in
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => {
              setWarnVisible(false);
              void onTimeoutRef.current();
            }}
          >
            Sign out now
          </button>
        </div>
      </Modal>
    );
  },
);

export type { IdleTimerHandle };

/**
 * Read + clear the one-shot signout reason set by the idle path. The
 * login page consumes this to render the inactivity toast exactly once.
 */
export function consumeSignoutReason(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const reason = sessionStorage.getItem(SIGNOUT_REASON_KEY);
  if (reason) sessionStorage.removeItem(SIGNOUT_REASON_KEY);
  return reason;
}

export function setSignoutReason(reason: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(SIGNOUT_REASON_KEY, reason);
}

/**
 * Resolve idle-timer config from Vite env. Inputs are minutes (matching
 * the server-side AUTH_*_TTL_MIN knobs); converted to ms here for the
 * timer math. Defaults: 30 min idle, 2 min warn lead. `0` disables.
 */
export function resolveIdleConfig(): { enabled: boolean; idleMs: number; warnLeadMs: number } {
  const idleMin = parseEnvInt(import.meta.env.VITE_IDLE_TIMEOUT_MIN, 30);
  const warnLeadMin = parseEnvInt(import.meta.env.VITE_IDLE_WARN_LEAD_MIN, 2);
  const idleMs = idleMin * 60_000;
  const warnLeadMs = warnLeadMin * 60_000;
  return {
    enabled: idleMs > 0,
    idleMs,
    warnLeadMs: Math.min(warnLeadMs, Math.max(0, idleMs - 1)),
  };
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
