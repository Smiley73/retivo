/**
 * The in-memory record of what the connected assistant asked for and what the
 * tab answered. Bounded (entry count and a per-entry cap on the retained
 * payload), never persisted, and fed only from settled calls: it has no input
 * the pairing code, a nonce or a proof could travel in.
 *
 * Cleared when the auth session ends and when a new pairing begins; a plain
 * Disconnect keeps it so the person can still read what was shared.
 */
import type { ErrorCode } from '@retirement/assistant-protocol';

export const AUDIT_MAX_ENTRIES = 200;
/** Largest result (UTF-8 bytes) kept verbatim on an entry; a larger one keeps only its size. */
export const AUDIT_MAX_PAYLOAD_BYTES = 64 * 1024;

/** The arguments the bridge sent, as JSON text, are kept to this many characters; a longer one ends in an ellipsis. */
export const AUDIT_MAX_ARGS_CHARS = 2_000;

const MAX_SUMMARY_CHARS = 200;
const MAX_SUMMARY_VALUE_CHARS = 40;

export type AuditOutcome = 'ok' | ErrorCode;

export interface AuditEntry {
  /** Increases by one per recorded call within this page load. */
  id: number;
  /** Epoch milliseconds the call settled. */
  at: number;
  tool: string;
  /** Argument names with short scalar values; never nested content. */
  argsSummary: string;
  /** The arguments as the bridge sent them, JSON text, capped at `AUDIT_MAX_ARGS_CHARS`. */
  argsText: string;
  outcome: AuditOutcome;
  durationMs: number;
  /** UTF-8 size of the result the call produced. */
  bytes: number;
  /** Whether finishing this call moved the idle clock (the D7 switch). */
  movedIdleClock: boolean;
  /** The exact result as sent, or `null` when it exceeded the per-entry cap. */
  payload: string | null;
  payloadTruncated: boolean;
}

export type AuditInput = Omit<AuditEntry, 'id' | 'payload' | 'payloadTruncated'> & { payload: string };

const utf8 = new TextEncoder();

/** `scenarioId=abc, flag=true, items=[3]`: enough to recognise a call, too little to carry plan data. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => {
    if (typeof value === 'string') return `${key}=${value.slice(0, MAX_SUMMARY_VALUE_CHARS)}`;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return `${key}=${String(value)}`;
    if (Array.isArray(value)) return `${key}=[${value.length}]`;
    return `${key}={…}`;
  });
  return parts.join(', ').slice(0, MAX_SUMMARY_CHARS);
}

function capArgsText(text: string): string {
  const characters = Array.from(text);
  return characters.length <= AUDIT_MAX_ARGS_CHARS ? text : `${characters.slice(0, AUDIT_MAX_ARGS_CHARS - 1).join('')}…`;
}

export class AuditLog {
  private list: readonly AuditEntry[] = [];
  private nextId = 1;
  private droppedCount = 0;

  entries(): readonly AuditEntry[] {
    return this.list;
  }

  /** How many older entries the bound has pushed out since the log was last cleared. */
  dropped(): number {
    return this.droppedCount;
  }

  record(input: AuditInput): void {
    const { payload, ...rest } = input;
    const fits = utf8.encode(payload).length <= AUDIT_MAX_PAYLOAD_BYTES;
    const entry: AuditEntry = {
      ...rest,
      id: this.nextId,
      argsText: capArgsText(rest.argsText),
      payload: fits ? payload : null,
      payloadTruncated: !fits,
    };
    this.nextId += 1;
    const next = [...this.list, entry];
    this.droppedCount += Math.max(0, next.length - AUDIT_MAX_ENTRIES);
    this.list = next.slice(-AUDIT_MAX_ENTRIES);
  }

  clear(): void {
    this.droppedCount = 0;
    if (this.list.length > 0) this.list = [];
  }
}
