/**
 * On-device diagnostics logger. Two capped in-memory ring buffers — one for
 * errors/warnings, one for breadcrumbs (info/log) — so breadcrumbs can never
 * evict error/warning history. The rings are the authoritative store; a
 * guarded, fire-and-forget debounced flush mirrors new entries into the
 * local-only `diagnosticLogs` IDB store (via `db/store.ts` helpers) so they
 * survive a crash/reload. Everything client-side — nothing leaves the device
 * (zero-knowledge / no-tracking).
 *
 * Must-not-throw contract: every public entry point — and the flush — is
 * wrapped so a logger-internal failure (IDB unavailable in private mode,
 * quota-exceeded, a `redactArgs` throw) NEVER propagates into a `console.*`
 * call site, `componentDidCatch`, or the sync state machine. On IDB failure the
 * in-memory rings remain authoritative.
 *
 * Bounded throughput: the debounced flush caps per-window enqueue work
 * (`MAX_FLUSH_BATCH`), and consecutive identical entries are coalesced — a tight
 * error loop / chatty hot-path `console.log` bumps a `count` on the existing
 * most-recent ring entry instead of re-running `redactMessage`/`redactArgs` and
 * pushing a fresh entry, so the main thread is not pinned on redaction. The
 * coalescing window resets on any differing entry.
 */
import {
  appendDiagnosticLogs,
  clearDiagnosticLogs,
  type DiagnosticLogEntry,
} from '../../db/store.js';
import { CLIENT_BUILD_ID } from '../build-id.js';
import { redactArgs, redactMessage } from './redact.js';

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'log';
export type DiagnosticSource = 'console' | 'window' | 'boundary' | 'sync';

export interface DiagnosticEntry {
  /** Stable unique id (primary key in IDB). */
  id: string;
  /** Strictly-monotonic insertion order — drives the IDB prune cursor.
   *  Allocated authoritatively inside the append transaction; the in-memory
   *  value is a provisional placeholder until the flush re-stamps it. */
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
  /** Count of consecutive identical captures coalesced into this entry.
   *  Absent / 1 = a single capture; >1 = that many identical lines collapsed.
   *  Bumped in place on the most-recent ring entry instead of pushing a fresh
   *  entry so a tight identical loop never re-runs redaction. */
  count?: number;
}

// Ring caps. Errors/warnings keep ~1000 of history; breadcrumbs ~200 so
// a chatty info/log stream never evicts error/warning entries.
const MAX_ERRORS = 1000;
const MAX_BREADCRUMBS = 200;
// Combined IDB cap (errors + breadcrumbs) — the persisted store mirrors both
// rings; prune keeps it from growing unbounded across reloads. Exported so the
// startup backstop prune (main.tsx) trims with the same bound.
export const MAX_PERSISTED = MAX_ERRORS + MAX_BREADCRUMBS;

// Debounce + bounded-throughput knobs.
const FLUSH_DEBOUNCE_MS = 1_000;
// Max entries drained into a single flush transaction so one window can't pin
// the main thread serializing a flood.
const MAX_FLUSH_BATCH = 200;

/** Two capped rings + the flush queue + debounce timer. Module singleton. */
const errorRing: DiagnosticEntry[] = [];
const breadcrumbRing: DiagnosticEntry[] = [];
// Entries appended since the last successful flush, awaiting persistence.
let flushQueue: DiagnosticEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Provisional in-memory seq; the IDB append re-stamps the authoritative value.
let memSeq = 0;

// Coalescing window. The key + the entry it produced are tracked so a
// consecutive identical capture (same level/source/namespace/message/detail)
// bumps `count` on the existing ring entry instead of re-redacting + pushing a
// fresh one. `null` = no open window (next capture always starts fresh). The
// key is computed BEFORE the redaction pass so a duplicate short-circuits ahead
// of `redactMessage`/`redactArgs`.
let lastCoalesceKey: string | null = null;
let lastCoalesceEntry: DiagnosticEntry | null = null;

// Monotonic clear epoch. `clear()` bumps this; an in-flight `flush()`
// captures it before its `await appendDiagnosticLogs` and, on return, treats a
// changed epoch as authoritative: it bails WITHOUT resurrecting the drained
// batch (a cross-user wipe between drain and rejection must not re-queue the
// prior user's entries into the now-cleared queue — a cross-user leak).
let clearEpoch = 0;

/**
 * Saved-original `console.error`, shared from `install.ts`. `recordCaught`
 * re-emits to devtools through THIS reference — never the shimmed `console.error`
 * — so an ErrorBoundary catch is recorded exactly once (source `boundary`) and
 * is not also re-captured by the console shim. Defaults to the live binding so
 * the logger is usable before `install.ts` wires the saved original (and in
 * tests that don't install).
 */
let devtoolsError: (...args: unknown[]) => void = (...args) => {
  // Explicit devtools passthrough for recordCaught — uses the live
  // binding until install.ts wires the saved original.
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
 * Parse a leading `[namespace]` token out of the first string arg (the repo's
 * existing console convention, e.g. `[sync] …`, `[auth] …`). Returns the parsed
 * namespace + the message remainder, or no namespace when the first arg is not
 * a `[ns] …`-prefixed string.
 */
export function parseNamespace(first: unknown): {
  namespace?: string;
  rest: unknown;
} {
  if (typeof first !== 'string') return { rest: first };
  const match = /^\[([^\]]+)\]\s*(.*)$/s.exec(first);
  if (!match) return { rest: first };
  return { namespace: match[1], rest: match[2] };
}

/** Push to the right ring with cap-eviction; enqueue for the debounced flush. */
function pushEntry(entry: DiagnosticEntry, isBreadcrumb: boolean): void {
  const ring = isBreadcrumb ? breadcrumbRing : errorRing;
  const cap = isBreadcrumb ? MAX_BREADCRUMBS : MAX_ERRORS;
  ring.push(entry);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
  flushQueue.push(entry);
  scheduleFlush();
}

// Delimiter between coalesce-key tokens: a unit-separator (U+001F) that won't
// occur in normal console output, so adjacent-token-boundary collisions
// (`['ab','c']` vs `['a','bc']`) can't over-coalesce.
const COALESCE_DELIM = '\x1F';
// Cap the per-Error message token so a giant message can't bloat the key;
// mirrors redact.ts MAX_STRING_LENGTH.
const COALESCE_MESSAGE_CAP = 2_000;

/**
 * Reduce a single raw arg to a coalesce token. An `Error` keys on
 * `name + ':' + message` — `JSON.stringify(new Error(...))` is `'{}'` (Error
 * own-props are non-enumerable), so two DIFFERENT errors would otherwise share a
 * key and over-coalesce, dropping the second message. Other non-strings keep a
 * bounded `JSON.stringify`. A throw propagates to the caller's guard.
 */
function coalesceToken(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const name = typeof arg.name === 'string' ? arg.name : 'Error';
    const message = typeof arg.message === 'string' ? arg.message : '';
    return `${name}:${message.slice(0, COALESCE_MESSAGE_CAP)}`;
  }
  return JSON.stringify(arg) ?? '';
}

/**
 * Cheap coalescing key from the level/source + the RAW (un-redacted) args.
 * Computed before the redaction pass so a consecutive duplicate short-circuits
 * ahead of `redactMessage`/`redactArgs`. Error-aware (so two distinct errors
 * never collapse) and delimiter-joined (so token-boundary collisions can't
 * over-coalesce). Stringification is guarded so a hostile arg never throws here
 * (must-not-throw); on failure the key is `null` so the entry is treated as
 * non-duplicate and follows the normal path.
 */
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

/**
 * Record one entry (coalescing). On a consecutive identical capture, bump
 * `count` on the most-recent ring entry (and its queued copy, if still pending)
 * instead of re-redacting + pushing a fresh entry — the short-circuit happens
 * BEFORE `buildEntry`'s redaction pass. Any differing capture resets the window
 * and pushes a new entry.
 */
function recordEntry(
  level: DiagnosticLevel,
  source: DiagnosticSource,
  args: readonly unknown[],
  isBreadcrumb: boolean,
): void {
  const key = coalesceKey(level, source, args);
  if (key !== null && key === lastCoalesceKey && lastCoalesceEntry !== null) {
    // Duplicate of the most-recent entry → bump its count in place; never
    // re-redact, never push a new entry. The queued copy is the same object
    // reference (pushEntry enqueues the entry it pushed), so a still-pending
    // flush picks up the bump automatically.
    lastCoalesceEntry.count = (lastCoalesceEntry.count ?? 1) + 1;
    if (!flushQueue.includes(lastCoalesceEntry)) {
      // The prior entry already flushed (drained from the queue) — re-enqueue
      // it so the updated count is re-persisted (the IDB put overwrites by id).
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

/**
 * Build an entry from a level/source + arg list. Redaction is wrapped so
 * a `redactArgs`/`redactMessage` throw collapses to a placeholder rather than
 * propagating.
 */
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

/**
 * Record an info/log breadcrumb. Breadcrumbs land in the smaller ring so they
 * never evict error/warning history. Never throws.
 */
export function recordBreadcrumb(level: 'info' | 'log', ...args: unknown[]): void {
  try {
    recordEntry(level, 'console', args, true);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record a non-console capture from a global handler (`window` error /
 * unhandledrejection). Sourced `window`; never throws.
 */
export function recordWindowError(...args: unknown[]): void {
  try {
    recordEntry('error', 'window', args, false);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record a non-console capture from a `setSyncState({kind:'error'})` transition.
 * Sourced `sync`; never throws.
 */
export function recordSyncError(...args: unknown[]): void {
  try {
    recordEntry('error', 'sync', args, false);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record a non-error `sync` transition worth keeping for debugging — notably the
 * `stale` / "refresh needed" state and the per-mutation conflict reasons behind
 * it. Sourced `sync` at `warn` level so it lands in the durable error/warn ring
 * (not the evictable breadcrumb ring) without implying a crash. Never throws.
 */
export function recordSyncWarn(...args: unknown[]): void {
  try {
    recordEntry('warn', 'sync', args, false);
  } catch {
    /* must-not-throw */
  }
}

/**
 * Record an `ErrorBoundary.componentDidCatch`. Sourced `boundary` and
 * recorded EXACTLY ONCE — re-emit to devtools through the SAVED-ORIGINAL
 * `console.error` (never the shimmed one) so output is preserved without the
 * shim re-capturing it. Never throws into React's error lifecycle.
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
  // Devtools passthrough via the saved original (NOT console.error directly,
  // which the shim would re-capture). Guarded so it can't throw into React.
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
 * Empty both rings + the flush queue and cancel any pending flush. Called by
 * the card Clear AND by every `dropLocalDatabase()` wipe path so a
 * surviving session / the next cross-user account can't re-persist or export
 * the prior user's captured data from the in-memory rings.
 */
export function clear(): void {
  errorRing.length = 0;
  breadcrumbRing.length = 0;
  flushQueue = [];
  lastCoalesceKey = null;
  lastCoalesceEntry = null;
  // Bump the epoch so an in-flight flush awaiting `appendDiagnosticLogs` treats
  // the cleared state as authoritative and does NOT resurrect its drained batch
  // (cross-user leak closure).
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
 * Persist the queued entries into the `diagnosticLogs` IDB store, append+prune
 * in one transaction. Fire-and-forget + fully guarded: an IDB
 * failure (private mode / quota) leaves the rings authoritative and is
 * swallowed. Drains at most `MAX_FLUSH_BATCH` entries per call; a larger
 * backlog re-schedules itself.
 */
export async function flush(): Promise<void> {
  if (flushQueue.length === 0) return;
  const batch = flushQueue.slice(0, MAX_FLUSH_BATCH);
  // Optimistically remove the drained slice; restore on failure so nothing is
  // silently lost from the persistence queue.
  flushQueue = flushQueue.slice(batch.length);
  // Capture the clear epoch BEFORE the await. A `clear()` (cross-user wipe)
  // that interleaves with this in-flight flush bumps the epoch; on return we
  // treat the cleared state as authoritative and bail WITHOUT touching the
  // (now-cleared) rings or queue — so the prior user's drained batch is never
  // resurrected into a fresh user's queue.
  const epochAtStart = clearEpoch;
  try {
    const rows: DiagnosticLogEntry[] = batch.map((e) => ({ ...e }));
    const persisted = await appendDiagnosticLogs(rows, MAX_PERSISTED);
    if (clearEpoch !== epochAtStart) return; // cleared mid-flight — drop silently.
    // Re-stamp the in-memory entries with the authoritative cross-tab seq so a
    // later getEntries()/export orders consistently with the persisted store.
    const bySeq = new Map(persisted.map((row) => [row.id, row.seq]));
    for (const ring of [errorRing, breadcrumbRing]) {
      for (const entry of ring) {
        const seq = bySeq.get(entry.id);
        if (typeof seq === 'number') entry.seq = seq;
      }
    }
  } catch {
    if (clearEpoch !== epochAtStart) return; // cleared mid-flight — do NOT re-queue.
    // IDB unavailable / quota-exceeded — keep the rings authoritative and
    // re-queue the drained batch so a later flush retries it.
    flushQueue = [...batch, ...flushQueue];
    return;
  }
  // More backlog than one batch — schedule another window.
  if (flushQueue.length > 0) scheduleFlush();
}

/**
 * Wipe BOTH the in-memory rings and the persisted IDB store. The card Clear
 * action. Guarded so a card click can't throw on IDB failure (the rings
 * are still cleared synchronously first).
 */
export async function clearAll(): Promise<void> {
  clear();
  try {
    await clearDiagnosticLogs();
  } catch {
    /* must-not-throw — rings already cleared */
  }
}
