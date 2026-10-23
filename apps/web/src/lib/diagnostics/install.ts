/**
 * Install/uninstall the diagnostics capture layer: wraps `console.*` (original first, recursion-guarded) and the global `error` / `unhandledrejection` handlers.
 * A `pagehide` / `visibilitychange→hidden` listener forces a final flush; a crash can lose only the last unflushed batch.
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

// Recursion guard: a logger-internal console.error must not re-enter the shim.
let inShim = false;

function wrap(
  original: ConsoleMethod,
  forward: (...args: unknown[]) => void,
): ConsoleMethod {
  return (...args: unknown[]): void => {
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

/** Install the capture layer; call first in `main.tsx` so boot-time output is captured. */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  // Save the raw references: restoring a `.bind(console)` wrapper would leave a different function
  // in place.
  saved = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log,
  };
  // Lets recordCaught re-emit to devtools without the shim re-capturing it.
  setDevtoolsError(saved.error);

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

    // pagehide covers tab close, navigation and bfcache; visibilitychange→hidden covers mobile
    // backgrounding where pagehide may not fire.
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

/** Restore the original `console.*` and remove every listener; idempotent. */
export function uninstallDiagnostics(): void {
  if (!installed) return;
  installed = false;

  if (saved) {
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
