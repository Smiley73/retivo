/**
 * Runs the `call` frames the bridge relays. The registry (packages/assistant-
 * protocol) says which tools exist and how long each may take; handlers are
 * registered here by tool name and filled by the tool rows. A name with no
 * handler is answered `TOOL_NOT_SUPPORTED` with no data, which is how an older
 * tab stays honest about a newer bridge.
 *
 * Consent is the second gate (the first is the tab never saying `ready` before the
 * person allows): a call with no consent record is answered `WORKSPACE_LOCKED`, so even
 * a bug that sends `ready` early exposes nothing. A handler gets its share view builder,
 * bound to the record that was current when the call started.
 *
 * Caps: `MAX_IN_FLIGHT_CALLS` at once, each call under its descriptor's
 * `timeoutMs`, a result over `MAX_TOOL_RESULT_BYTES` becomes `OUTPUT_TOO_LARGE`
 * and is never sent. The per-minute limit is the bridge's alone.
 */
import {
  MAX_IN_FLIGHT_CALLS,
  MAX_TOOL_RESULT_BYTES,
  failureResult,
  toolNotSupported,
  type TabFrame,
  type ToolEntry,
  type ToolResult,
} from '@retirement/assistant-protocol';
import { summarizeArgs, type AuditOutcome } from './audit-log';
import type { ConsentRecord } from './sharing/consent';
import { buildShareView, type ShareSource, type ShareView } from './sharing/view';

/** What a handler uses to say anything about the plan: the record's choices, applied. */
interface ShareBinding {
  /** The session's consent record: the choices a response must disclose, fixed for the session. */
  readonly consent: ConsentRecord;
  /** The share view of `source` under the record's choices, with ages on the dispatcher's clock. */
  buildView(source: ShareSource): ShareView;
}

export interface ToolCallContext {
  /** Aborted on `cancel`, on timeout and when the session ends; a handler should stop work when it fires. */
  signal: AbortSignal;
  progress(update: { fraction?: number; message?: string }): void;
  /** The only way a handler turns plan data into something it may return. */
  share: ShareBinding;
}

/** `args` has already been validated against the registry entry's input schema. */
export type ToolHandler = (args: Record<string, unknown>, context: ToolCallContext) => Promise<ToolResult> | ToolResult;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** What the session needs to know about a call once its result has been sent. */
export interface SettledCall {
  tool: string;
  argsSummary: string;
  /** The arguments as received, JSON text. */
  argsText: string;
  outcome: AuditOutcome;
  durationMs: number;
  bytes: number;
  /** The exact result frame body that was sent. */
  payload: string;
  /** A registered handler returned a successful result that was sent: the only kind that counts as activity. */
  completed: boolean;
}

export interface DispatcherOptions {
  registry: readonly ToolEntry[];
  timers: Timers;
  now: () => number;
  /** `unlockResolved`, `isUnlocked` and a household, read at call time. */
  isWorkspaceReady: () => boolean;
  /** The session's current consent record, read at call time; `null` until the person allows. */
  getConsent: () => ConsentRecord | null;
  appBuildId: string;
  /** Writes a frame to the socket; failures are the socket's to report. */
  send: (frame: TabFrame) => void;
  onSettled: (call: SettledCall) => void;
}

interface InFlightCall {
  id: string;
  tool: string;
  argsSummary: string;
  argsText: string;
  startedAt: number;
  controller: AbortController;
  timer: unknown;
}

const utf8 = new TextEncoder();
const MAX_PROGRESS_MESSAGE_CHARS = 200;

export class CallDispatcher {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly inFlight = new Map<string, InFlightCall>();

  constructor(private readonly options: DispatcherOptions) {}

  /** Registers the handler for a registry tool; returns the function that removes it again. */
  register(name: string, handler: ToolHandler): () => void {
    if (!this.options.registry.some((entry) => entry.name === name)) {
      throw new Error(`${name} is not a tool in the registry`);
    }
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  /** `false` when `id` is already running, which the session treats as a protocol violation. */
  handleCall(frame: { id: string; tool: string; args: Record<string, unknown> }): boolean {
    if (this.inFlight.has(frame.id)) return false;
    const startedAt = this.options.now();
    const argsSummary = summarizeArgs(frame.args);
    const argsText = JSON.stringify(frame.args);
    const immediate = (result: ToolResult): void =>
      this.answer({ tool: frame.tool, id: frame.id, argsSummary, argsText, startedAt }, result, false);

    if (this.inFlight.size >= MAX_IN_FLIGHT_CALLS) {
      immediate(failureResult('TOO_MANY_IN_FLIGHT', `At most ${MAX_IN_FLIGHT_CALLS} calls can run at once. Wait for one to finish.`));
      return true;
    }
    if (!this.options.isWorkspaceReady()) {
      immediate(failureResult('WORKSPACE_LOCKED', 'The Retivo workspace is locked. Unlock it in the app and try again.'));
      return true;
    }
    const consent = this.options.getConsent();
    if (consent === null) {
      immediate(failureResult('WORKSPACE_LOCKED', 'The person has not allowed this assistant to read their plan. Ask them to allow it in the Retivo tab.'));
      return true;
    }
    const handler = this.handlers.get(frame.tool);
    const entry = this.options.registry.find((candidate) => candidate.name === frame.tool);
    if (handler === undefined || entry === undefined) {
      immediate(toolNotSupported(frame.tool, this.options.appBuildId));
      return true;
    }
    const parsed = entry.inputSchema.safeParse(frame.args);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join('.') ?? '';
      immediate(failureResult('INVALID_ARGS', `The arguments for ${frame.tool} are not valid (at "${path}").`));
      return true;
    }

    const controller = new AbortController();
    const call: InFlightCall = {
      id: frame.id,
      tool: frame.tool,
      argsSummary,
      argsText,
      startedAt,
      controller,
      timer: this.options.timers.set(() => {
        if (!this.inFlight.has(call.id)) return;
        controller.abort();
        this.finish(call, failureResult('CALL_TIMEOUT', `${frame.tool} did not finish within ${Math.round(entry.timeoutMs / 1000)} seconds.`), false);
      }, entry.timeoutMs),
    };
    this.inFlight.set(call.id, call);

    const context: ToolCallContext = {
      signal: controller.signal,
      progress: (update) => this.sendProgress(call, update),
      share: {
        consent,
        buildView: (source) => buildShareView(source, consent.choices, { now: new Date(this.options.now()) }),
      },
    };
    void (async () => handler(parsed.data as Record<string, unknown>, context))().then(
      (result) => this.finish(call, result, result.ok),
      () => this.finish(call, failureResult('INTERNAL', `${frame.tool} failed unexpectedly.`), false),
    );
    return true;
  }

  /** The bridge gave up on a call: abort the handler and answer `CANCELLED` once. */
  handleCancel(id: string): void {
    const call = this.inFlight.get(id);
    if (call === undefined) return;
    call.controller.abort();
    this.finish(call, failureResult('CANCELLED', 'The request was cancelled.'), false);
  }

  /** The session is over: stop every handler and drop every pending answer without sending one. */
  abortAll(): void {
    for (const call of this.inFlight.values()) {
      this.options.timers.clear(call.timer);
      call.controller.abort();
    }
    this.inFlight.clear();
  }

  private sendProgress(call: InFlightCall, update: { fraction?: number; message?: string }): void {
    if (this.inFlight.get(call.id) !== call) return;
    const { fraction, message } = update;
    this.options.send({
      type: 'progress',
      id: call.id,
      ...(fraction !== undefined && { fraction: Math.min(1, Math.max(0, fraction)) }),
      ...(message !== undefined && { message: message.slice(0, MAX_PROGRESS_MESSAGE_CHARS) }),
    });
  }

  /** Settles a running call exactly once; a late result for a call already settled falls through here and is dropped. */
  private finish(call: InFlightCall, result: ToolResult, fromHandler: boolean): void {
    if (this.inFlight.get(call.id) !== call) return;
    this.inFlight.delete(call.id);
    this.options.timers.clear(call.timer);
    this.answer(call, result, fromHandler);
  }

  private answer(call: { id: string; tool: string; argsSummary: string; argsText: string; startedAt: number }, produced: ToolResult, fromHandler: boolean): void {
    const producedBytes = utf8.encode(JSON.stringify(produced)).length;
    const oversize = producedBytes > MAX_TOOL_RESULT_BYTES;
    const result = oversize
      ? failureResult('OUTPUT_TOO_LARGE', `${call.tool} produced more data than can be sent in one result.`)
      : produced;
    const outcome: AuditOutcome = result.ok ? 'ok' : result.error.code;
    this.options.send({ type: 'result', id: call.id, result });
    this.options.onSettled({
      tool: call.tool,
      argsSummary: call.argsSummary,
      argsText: call.argsText,
      outcome,
      durationMs: this.options.now() - call.startedAt,
      bytes: producedBytes,
      payload: JSON.stringify(result),
      completed: fromHandler && result.ok,
    });
  }
}
