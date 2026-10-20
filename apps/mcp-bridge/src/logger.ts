/**
 * The bridge's only diagnostics channel. Over stdio, stdout carries MCP
 * JSON-RPC, so every log line goes to stderr, and the logger takes typed events
 * rather than free text: nothing that can hold plan data (arguments, results,
 * registry text) or the pairing code has a field to travel in.
 */
import type { ErrorCode } from '@retirement/assistant-protocol';

export type LogEvent =
  | { event: 'listening'; port: number; origin: string }
  | { event: 'upgrade_rejected'; reason: 'origin' | 'host' | 'duplicate_header' | 'method'; origin?: string }
  | { event: 'session_started' }
  | { event: 'session_paired' }
  | { event: 'session_ready' }
  | { event: 'session_ended'; closeCode?: number; handshakeError?: ErrorCode }
  | { event: 'socket_rejected'; closeCode: number }
  | { event: 'tool_call'; tool: string; callId: string; bytes: number }
  | { event: 'tool_result'; tool: string; callId: string; durationMs: number; bytes: number; outcome: ToolOutcome; errorCode?: ErrorCode }
  | { event: 'tool_not_paired'; tool: string }
  | { event: 'result_ignored'; callId: string }
  | { event: 'mcp_error'; name: string };

export type ToolOutcome = 'ok' | 'error' | 'timeout' | 'cancelled';

export interface Logger {
  log(event: LogEvent): void;
}

/** Longest origin written to a log line; the header is attacker-controlled. */
const MAX_LOGGED_ORIGIN = 200;

/** Writes each event as one JSON line to `write` (stderr by default). */
export function createLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  return {
    log(event) {
      const entry =
        event.event === 'upgrade_rejected' && event.origin !== undefined
          ? { ...event, origin: event.origin.slice(0, MAX_LOGGED_ORIGIN) }
          : event;
      write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    },
  };
}
