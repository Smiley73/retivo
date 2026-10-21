/**
 * Call bookkeeping between the MCP side and the one paired tab. The relay owns
 * what the SDK does not: bridge-assigned call ids, the registry's per-tool
 * timeout, cancel forwarding, the in-flight and per-minute caps, and ignoring a
 * result that arrives for a call that is unknown or already settled.
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_CALLS_PER_MINUTE,
  MAX_IN_FLIGHT_CALLS,
  encodeFrame,
  failureResult,
  formatPairingCode,
  notPairedAwaitingCode,
  notPairedAwaitingConsent,
  type BridgeFrame,
  type ToolEntry,
  type ToolResult,
} from '@retirement/assistant-protocol';
import type { Logger, ToolOutcome } from './logger.js';
import type { PairingCodeStore } from './pairing-code-store.js';

/** Where the relay writes frames for the tab; the session behind it owns the socket. */
export interface TabLink {
  sendText(text: string): void;
}

export interface CallOptions {
  /** Aborted when the MCP client cancels the request. */
  signal: AbortSignal;
  /** Set only when the request carried a `progressToken`. */
  onProgress?: (progress: { fraction?: number; message?: string }) => void;
}

export interface RelayOptions {
  /** The app origin; the `NOT_PAIRED` instructions point into it. */
  origin: string;
  codes: PairingCodeStore;
  logger: Logger;
  now?: () => number;
}

type Phase = 'unpaired' | 'awaiting-consent' | 'ready';

interface PendingCall {
  tool: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  onProgress: CallOptions['onProgress'];
  detach: () => void;
  resolve: (result: ToolResult) => void;
}

const WINDOW_MS = 60_000;
const utf8 = new TextEncoder();

export class Relay {
  private readonly now: () => number;
  private phase: Phase = 'unpaired';
  private link: TabLink | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private sentAt: number[] = [];

  constructor(private readonly options: RelayOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The tab accepted the code; calls now report that the person has yet to consent. */
  beginConsent(): void {
    this.phase = 'awaiting-consent';
  }

  /** The tab sent `ready`: calls flow through `link`. */
  activate(link: TabLink): void {
    this.phase = 'ready';
    this.link = link;
    this.sentAt = [];
  }

  /** Any disconnect ends the session: every in-flight call fails and the next call mints a fresh code. */
  endSession(): void {
    this.phase = 'unpaired';
    this.link = null;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, failureResult('CANCELLED', 'The Retivo tab disconnected before the call finished.'), 'cancelled');
    }
  }

  async callTool(entry: ToolEntry, args: Record<string, unknown>, options: CallOptions): Promise<ToolResult> {
    if (this.phase === 'unpaired') {
      const { code, expiresAtMs } = this.options.codes.activeOrMint();
      this.options.logger.log({ event: 'tool_not_paired', tool: entry.name });
      return notPairedAwaitingCode({
        origin: this.options.origin,
        pairingCode: formatPairingCode(code),
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    }
    if (this.phase === 'awaiting-consent' || this.link === null) return notPairedAwaitingConsent();
    if (options.signal.aborted) return failureResult('CANCELLED', 'The request was cancelled.');
    if (this.pending.size >= MAX_IN_FLIGHT_CALLS) {
      return failureResult('TOO_MANY_IN_FLIGHT', `At most ${MAX_IN_FLIGHT_CALLS} calls can run at once. Wait for one to finish.`);
    }
    const startedAt = this.now();
    this.sentAt = this.sentAt.filter((at) => startedAt - at < WINDOW_MS);
    if (this.sentAt.length >= MAX_CALLS_PER_MINUTE) {
      return failureResult('RATE_LIMITED', `At most ${MAX_CALLS_PER_MINUTE} calls can be made per minute. Wait a moment.`);
    }

    const id = randomUUID();
    const encoded = encodeFrame({ type: 'call', id, tool: entry.name, args });
    if (!encoded.ok) return failureResult('INVALID_ARGS', 'The arguments are too large to send to Retivo.');
    try {
      this.link.sendText(encoded.text);
    } catch {
      return failureResult('INTERNAL', 'The call could not be sent to the Retivo tab.');
    }
    this.sentAt.push(startedAt);
    this.options.logger.log({ event: 'tool_call', tool: entry.name, callId: id, bytes: utf8.encode(encoded.text).length });

    return new Promise<ToolResult>((resolve) => {
      const onAbort = (): void => {
        this.sendCancel(id, 'client');
        this.settle(id, failureResult('CANCELLED', 'The request was cancelled.'), 'cancelled');
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        this.sendCancel(id, 'timeout');
        this.settle(
          id,
          failureResult('CALL_TIMEOUT', `The Retivo tab did not answer ${entry.name} within ${Math.round(entry.timeoutMs / 1000)} seconds.`),
          'timeout',
        );
      }, entry.timeoutMs);
      this.pending.set(id, {
        tool: entry.name,
        startedAt,
        timer,
        onProgress: options.onProgress,
        detach: () => options.signal.removeEventListener('abort', onAbort),
        resolve,
      });
    });
  }

  /** A `progress` frame from the tab; ignored for an unknown call or when the request has no progress token. */
  handleProgress(frame: { id: string; fraction?: number; message?: string }): void {
    const { fraction, message } = frame;
    this.pending.get(frame.id)?.onProgress?.({
      ...(fraction !== undefined && { fraction }),
      ...(message !== undefined && { message }),
    });
  }

  /** A `result` frame from the tab; one for an unknown or settled call changes nothing. */
  handleResult(frame: { id: string; result: ToolResult }): void {
    if (!this.pending.has(frame.id)) {
      this.options.logger.log({ event: 'result_ignored', callId: frame.id });
      return;
    }
    this.settle(frame.id, frame.result, frame.result.ok ? 'ok' : 'error');
  }

  private sendCancel(id: string, reason: 'client' | 'timeout'): void {
    const frame: BridgeFrame = { type: 'cancel', id, reason };
    const encoded = encodeFrame(frame);
    if (!encoded.ok) return;
    try {
      this.link?.sendText(encoded.text);
    } catch {
      // The socket is already going away; endSession fails whatever is left.
    }
  }

  private settle(id: string, result: ToolResult, outcome: ToolOutcome): void {
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.detach();
    this.options.logger.log({
      event: 'tool_result',
      tool: call.tool,
      callId: id,
      durationMs: this.now() - call.startedAt,
      bytes: utf8.encode(JSON.stringify(result)).length,
      outcome,
      ...(!result.ok && { errorCode: result.error.code }),
    });
    call.resolve(result);
  }
}
