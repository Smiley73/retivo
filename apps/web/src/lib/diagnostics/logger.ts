/**
 * On-device diagnostics logger: two capped in-memory rings (errors/warnings, breadcrumbs) mirrored by a debounced, fire-and-forget flush into the local `diagnosticLogs` IDB store.
 * It must not throw into any caller (console sites, componentDidCatch, sync); consecutive identical entries are coalesced so a tight error loop does not pin the main thread on redaction.
 */
import {
  appendDiagnosticLogs,
  clearDiagnosticLogs,
  type DiagnosticLogEntry,
} from '../../db/store.js';
import { CLIENT_BUILD_ID } from '../build-id.js';
import { redactArgs, redactMessage } from './redact.js';

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'log';
type DiagnosticSource = 'console' | 'window' | 'boundary' | 'sync';

export interface DiagnosticEntry {
  /** Stable unique id (primary key in IDB). */
  id: string;
  /**
   * Monotonic insertion order for the IDB prune cursor; provisional in memory until the flush
   * re-stamps it.
   */
  seq: number;
  /** ISO 8601 UTC capture time. */
  ts: string;
  level: DiagnosticLevel;
  source: DiagnosticSource;
  /** Parsed `[namespace]` prefix from the first string arg, when present. */
  namespace?: string;
  /** Redacted, human-readable headline. */
  message: string;
  /** Redacted, serialized remaining args, when any. */
  detail?: string;
  buildId: string;
  /** `location.pathname` at capture time. */
  path: string;
  /** Consecutive identical captures coalesced into this entry; absent or 1 is a single capture. */
  count?: number;
}

// Breadcrumbs get the smaller ring so a chatty info/log stream never evicts error history.
const MAX_ERRORS = 1000;
const MAX_BREADCRUMBS = 200;
// Combined IDB cap; also the bound for the startup backstop prune in main.tsx.
export const MAX_PERSISTED = MAX_ERRORS + MAX_BREADCRUMBS;

const FLUSH_DEBOUNCE_MS = 1_000;
// Max entries per flush transaction, so one flood can't pin the main thread.
const MAX_FLUSH_BATCH = 200;

const errorRing: DiagnosticEntry[] = [];
const breadcrumbRing: DiagnosticEntry[] = [];
let flushQueue: DiagnosticEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Provisional in-memory seq; the IDB append re-stamps the authoritative value.
let memSeq = 0;

// Coalescing window: the key is computed before redaction so a duplicate skips it; null means no
// open window.
let lastCoalesceKey: string | null = null;
let lastCoalesceEntry: DiagnosticEntry | null = null;

// Bumped by clear(): an in-flight flush that sees a changed epoch bails instead of re-queueing the
// prior user's entries (cross-user leak).
let clearEpoch = 0;

// Saved-original console.error, so recordCaught re-emits to devtools without the console shim
// re-capturing it; defaults to the live binding until install.ts wires it.
let devtoolsError: (...args: unknown[]) => void = (...args) => {
  console.error(...args);
};

/** Wire the saved-original `console.error` (called by `installDiagnostics`). */
export function setDevtoolsError(fn: (...args: unknown[]) => void): void {
  devtoolsError = fn;
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentPath(): string {
  try {
    return typeof location !== 'undefined' ? location.pathname : '';
  } catch {
    return '';
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the counter-based id
  }
  return `diag-${Date.now()}-${memSeq}`;
}

/**
 * Split a leading `[namespace]` token off the first string arg (e.g. `[sync] …`); no namespace when
 * absent.
 */
function parseNamespace(first: unknown): {
  namespace?: string;
  rest: unknown;
} {
  if (typeof first !== 'string') return { rest: first };
  const match = /^\[([^\]]+)\]\s*(.*)$/s.exec(first);
  if (!match) return { rest: first };
  return { namespace: match[1], rest: match[2] };
}

function pushEntry(entry: DiagnosticEntry, isBreadcrumb: boolean): void {
  const ring = isBreadcrumb ? breadcrumbRing : errorRing;
  const cap = isBreadcrumb ? MAX_BREADCRUMBS : MAX_ERRORS;
  ring.push(entry);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
  flushQueue.push(entry);
  scheduleFlush();
}

// A unit separator that won't occur in console output, so token-boundary collisions can't
// over-coalesce.
const COALESCE_DELIM = '\x1F';
const COALESCE_MESSAGE_CAP = 2_000;

// Errors key on name + message: JSON.stringify(new Error()) is '{}', which would over-coalesce
// distinct errors.
function coalesceToken(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const name = typeof arg.name === 'string' ? arg.name : 'Error';
    const message = typeof arg.message === 'string' ? arg.message : '';
    return `${name}:${message.slice(0, COALESCE_MESSAGE_CAP)}`;
  }
  return JSON.stringify(arg) ?? '';
}

// Key from the raw args, computed before redaction; null on a stringify failure so the entry takes
// the normal path.
function coalesceKey(
  level: DiagnosticLevel,
  source: DiagnosticSource,
  args: readonly unknown[],
): string | null {
  try {
    return [level, source, ...args.map(coalesceToken)].join(COALESCE_DELIM);
  } catch {
    return null;
  }
}

function recordEntry(
  level: DiagnosticLevel,
  source: DiagnosticSource,
  args: readonly unknown[],
  isBreadcrumb: boolean,
): void {
  const key = coalesceKey(level, source, args);
  if (key !== null && key === lastCoalesceKey && lastCoalesceEntry !== null) {
    // Duplicate: bump count in place. The queued copy is the same object, so a pending flush picks
    // it up.
    lastCoalesceEntry.count = (lastCoalesceEntry.count ?? 1) + 1;
    if (!flushQueue.includes(lastCoalesceEntry)) {
      // Already flushed: re-enqueue so the new count is persisted (the put overwrites by id).
      flushQueue.push(lastCoalesceEntry);
      scheduleFlush();
    }
    return;
  }
  const entry = buildEntry(level, source, args);
  pushEntry(entry, isBreadcrumb);
  lastCoalesceKey = key;
  lastCoalesceEntry = entry;
}

function buildEntry(
  level: DiagnosticLevel,
  source: DiagnosticSource,
  args: readonly unknown[],
): DiagnosticEntry {
  let namespace: string | undefined;
  let message: string;
  let detail: string | undefined;
  try {
    const parsed = parseNamespace(args[0]);
    namespace = parsed.namespace;
    message = redactMessage(parsed.rest);
    detail = redactArgs(args.slice(1));
  } catch {
    message = '[redaction-failed]';
  }
  memSeq += 1;
  return {
    id: newId(),
    seq: memSeq,
    ts: nowIso(),
    level,
    source,
    ...(namespace ? { namespace } : {}),
    message,
    ...(detail !== undefined ? { detail } : {}),
    buildId: CLIENT_BUILD_ID,
    path: currentPath(),
  };
}

/** Record an error-level entry. Never throws. */
export function recordError(...args: unknown[]): void {
  try {
    recordEntry('error', 'console', args, false);
  } catch {
    /* must-not-throw */
  }
}

/** Record a warn-level entry. Never throws. */
export function recordWarn(...args: unknown[]): void {
  try {
    recordEntry('warn', 'console', args, false);
  } catch {
    /* must-not-throw */
  }
}

/** Record an info/log breadcrumb in the smaller ring. Never throws. */
export function recordBreadcrumb(level: 'info' | 'log', ...args: unknown[]): void {
  try {
    recordEntry(level, 'console', args, true);
  } catch {
    /* must-not-throw */
  }
}

/** Record a capture from a global handler (`window` error / unhandledrejection). Never throws. */
export function recordWindowError(...args: unknown[]): void {
  try {
    recordEntry('error', 'window', args, false);
  } catch {
    /* must-not-throw */
  }
}

/** Record a `setSyncState({kind:'error'})` transition. Never throws. */
export function recordSyncError(...args: unknown[]): void {
  try {
    recordEntry('error', 'sync', args, false);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record a non-error sync transition (e.g. `stale`, per-mutation conflict reasons) at `warn`, so it
 * lands in the durable ring. Never throws.
 */
export function recordSyncWarn(...args: unknown[]): void {
  try {
    recordEntry('warn', 'sync', args, false);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record an `ErrorBoundary.componentDidCatch` once, re-emitting through the saved-original
 * `console.error` so the shim does not re-capture it. Never throws.
 */
export function recordCaught(
  error: unknown,
  info?: { componentStack?: string | null },
): void {
  try {
    const componentStack = info?.componentStack;
    const args: unknown[] = ['ErrorBoundary caught:', error];
    if (componentStack) args.push(componentStack);
    recordEntry('error', 'boundary', args, false);
  } catch {
    /* must-not-throw */
  }
  // Via the saved original: console.error would be re-captured by the shim.
  try {
    devtoolsError('ErrorBoundary caught:', error, info?.componentStack);
  } catch {
    /* must-not-throw */
  }
}

/** Snapshot of both rings, newest-last (errors+breadcrumbs interleaved by seq). */
export function getEntries(): DiagnosticEntry[] {
  return [...errorRing, ...breadcrumbRing].sort((a, b) => a.seq - b.seq);
}

/**
 * Empty both rings and the flush queue and cancel any pending flush; every `dropLocalDatabase()`
 * wipe calls it so the next cross-user account cannot re-persist or export prior data.
 */
export function clear(): void {
  errorRing.length = 0;
  breadcrumbRing.length = 0;
  flushQueue = [];
  lastCoalesceKey = null;
  lastCoalesceEntry = null;
  // Bump the epoch so an in-flight flush does not resurrect its drained batch.
  clearEpoch += 1;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Persist queued entries to the `diagnosticLogs` store (append and prune in one transaction), at
 * most `MAX_FLUSH_BATCH` per call; an IDB failure leaves the rings authoritative.
 */
export async function flush(): Promise<void> {
  if (flushQueue.length === 0) return;
  const batch = flushQueue.slice(0, MAX_FLUSH_BATCH);
  flushQueue = flushQueue.slice(batch.length);
  // Capture the clear epoch before the await: a clear() during the flush must not see its drained
  // batch resurrected.
  const epochAtStart = clearEpoch;
  try {
    const rows: DiagnosticLogEntry[] = batch.map((e) => ({ ...e }));
    const persisted = await appendDiagnosticLogs(rows, MAX_PERSISTED);
    if (clearEpoch !== epochAtStart) return; // cleared mid-flight — drop silently.
    // Re-stamp with the authoritative cross-tab seq so getEntries() orders like the persisted
    // store.
    const bySeq = new Map(persisted.map((row) => [row.id, row.seq]));
    for (const ring of [errorRing, breadcrumbRing]) {
      for (const entry of ring) {
        const seq = bySeq.get(entry.id);
        if (typeof seq === 'number') entry.seq = seq;
      }
    }
  } catch {
    if (clearEpoch !== epochAtStart) return; // cleared mid-flight — do NOT re-queue.
    // IDB unavailable or over quota: re-queue the batch so a later flush retries.
    flushQueue = [...batch, ...flushQueue];
    return;
  }
  if (flushQueue.length > 0) scheduleFlush();
}

/** Wipe the in-memory rings and the persisted IDB store; never throws on IDB failure. */
export async function clearAll(): Promise<void> {
  clear();
  try {
    await clearDiagnosticLogs();
  } catch {
    /* must-not-throw — rings already cleared */
  }
}
