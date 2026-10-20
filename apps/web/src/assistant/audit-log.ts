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

export class AuditLog {
  private list: readonly AuditEntry[] = [];
  private nextId = 1;

  entries(): readonly AuditEntry[] {
    return this.list;
  }

  record(input: AuditInput): void {
    const { payload, ...rest } = input;
    const fits = utf8.encode(payload).length <= AUDIT_MAX_PAYLOAD_BYTES;
    const entry: AuditEntry = {
      ...rest,
      id: this.nextId,
      payload: fits ? payload : null,
      payloadTruncated: !fits,
    };
    this.nextId += 1;
    this.list = [...this.list, entry].slice(-AUDIT_MAX_ENTRIES);
  }

  clear(): void {
    if (this.list.length > 0) this.list = [];
  }
}
