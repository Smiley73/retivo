/**
 * Install / uninstall the diagnostics capture layer (lifecycle). Wraps
 * `console.{error,warn,info,log}` (ORIGINAL-first so devtools output is
 * preserved, recursion-guarded), wires the global `window` `error` /
 * `unhandledrejection` handlers, and registers a `pagehide` /
 * `visibilitychange→hidden` listener that forces a final flush so the last
 * debounced batch is persisted on a graceful tab hide/close/reload (a sudden
 * process crash can lose only the last un-flushed batch — accepted).
 *
 * Idempotent: a second `installDiagnostics()` (HMR double-mount, StrictMode)
 * is a no-op. `uninstallDiagnostics()` restores the original `console.*`,
 * removes every listener, and is the lifecycle-cleanup half required of a
 * stateful singleton (mirrors `closeNudgeChannel`).
 *
 * Capture sources: the console shim covers ALL console-routed sites
 * (incl. the `[sync]` `console.warn`); only non-console STATE transitions
 * (`setSyncState({kind:'error'})`, `ErrorBoundary.componentDidCatch`) get a
 * direct `record*` call elsewhere — they are NOT re-routed through console here.
 */
import {
  recordBreadcrumb,
  recordError,
  recordWarn,
  recordWindowError,
  setDevtoolsError,
  flush,
} from './logger.js';

type ConsoleMethod = (...args: unknown[]) => void;

interface SavedConsole {
  error: ConsoleMethod;
  warn: ConsoleMethod;
  info: ConsoleMethod;
  log: ConsoleMethod;
}

let installed = false;
let saved: SavedConsole | null = null;
let windowErrorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let finalFlushHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

// Module-level recursion guard. A logger-internal `console.error` (e.g. from a
// helper) must not re-enter the shim and loop; while we are forwarding to the
// logger, nested console calls go straight to the original.
let inShim = false;

/**
 * Wrap one console method: call the saved ORIGINAL first (devtools passthrough),
 * then forward to the logger under the recursion guard. The forward is fully
 * guarded so a logger failure can never break a `console.*` call site app-wide.
 */
function wrap(
  original: ConsoleMethod,
  forward: (...args: unknown[]) => void,
): ConsoleMethod {
  return (...args: unknown[]): void => {
    // Original first — preserve devtools exactly as before the shim.
    original(...args);
    if (inShim) return;
    inShim = true;
    try {
      forward(...args);
    } catch {
      /* must-not-throw into the console call site */
    } finally {
      inShim = false;
    }
  };
}

/**
 * Install the capture layer. First statement in `main.tsx`, before React
 * mounts, so console output / global errors during boot are captured too.
 */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  // Save the raw references (not bound copies) so `uninstallDiagnostics`
  // restores the EXACT prior bindings — restoring a `.bind(console)` wrapper
  // would leave a different function reference in place (and break test
  // round-trips). Console methods tolerate being called detached.
  saved = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log,
  };
  // Share the saved-original console.error so recordCaught re-emits to devtools
  // without the shim re-capturing it.
  setDevtoolsError(saved.error);

  // The diagnostics shim is the audited home for reassigning console.*.
  console.error = wrap(saved.error, (...args) => recordError(...args));
  console.warn = wrap(saved.warn, (...args) => recordWarn(...args));
  console.info = wrap(saved.info, (...args) => recordBreadcrumb('info', ...args));
  console.log = wrap(saved.log, (...args) => recordBreadcrumb('log', ...args));

  if (typeof window !== 'undefined') {
    windowErrorHandler = (event: ErrorEvent): void => {
      recordWindowError(event.message, event.error ?? undefined);
    };
    rejectionHandler = (event: PromiseRejectionEvent): void => {
      recordWindowError('Unhandled promise rejection', event.reason);
    };
    window.addEventListener('error', windowErrorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);

    // Final flush on graceful unload. `pagehide` fires on tab close /
    // navigation / bfcache; `visibilitychange→hidden` covers mobile
    // backgrounding where `pagehide` may not. Both fire-and-forget + guarded.
    finalFlushHandler = (): void => {
      void flush();
    };
    visibilityHandler = (): void => {
      if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('pagehide', finalFlushHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

/**
 * Restore the original `console.*` and remove every listener. Lifecycle
 * cleanup for the stateful singleton; idempotent.
 */
export function uninstallDiagnostics(): void {
  if (!installed) return;
  installed = false;

  if (saved) {
    // Restore the originals the shim replaced.
    console.error = saved.error;
    console.warn = saved.warn;
    console.info = saved.info;
    console.log = saved.log;
    saved = null;
  }

  if (typeof window !== 'undefined') {
    if (windowErrorHandler) window.removeEventListener('error', windowErrorHandler);
    if (rejectionHandler) window.removeEventListener('unhandledrejection', rejectionHandler);
    if (finalFlushHandler) window.removeEventListener('pagehide', finalFlushHandler);
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  }
  windowErrorHandler = null;
  rejectionHandler = null;
  finalFlushHandler = null;
  visibilityHandler = null;
  inShim = false;
}
