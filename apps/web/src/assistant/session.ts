/**
 * The tab's side of the assistant connection: one session at a time, framework
 * free, with the socket factory, clock and timers injected so unit tests script
 * every frame and the bridge suite drives a real socket.
 *
 * Handshake (the order is the protocol's): the bridge sends `hello`; the tab
 * checks the version for equality, answers one `pair` frame carrying a proof
 * derived from the code and both nonces, and sends `ready` only after the
 * bridge's own proof verifies in constant time. The code never travels: it is
 * held for the handshake, and dropped when the bridge proves itself or the
 * session ends. Anything out of order, any frame that does not decode, and a
 * wrong proof close the socket with the matching close code.
 *
 * A session ends, socket closed and every in-memory secret dropped, on any
 * `end(reason)` call or when the socket closes under it. A new session needs a
 * new code. Logging is state names only.
 */
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  TOOL_REGISTRY,
  computeBridgeProof,
  computeTabProof,
  constantTimeEqual,
  decodeFrame,
  encodeFrame,
  generateNonce,
  normalizePairingCode,
  type HandshakeErrorCode,
  type TabCloseReason,
  type TabFrame,
} from '@retirement/assistant-protocol';
import { bridgeSocketUrl } from './bridge-port';
import { AuditLog, type AuditEntry } from './audit-log';
import { CallDispatcher, type SettledCall, type Timers, type ToolHandler } from './dispatcher';
import { DEFAULT_CONSENT, type SessionConsent, type SessionEnd, type SessionPhase, type SocketFactory, type SocketLike } from './session-types';

/**
 * How long a socket may stay un-opened before the tab gives up. Long, because a browser keeps a loopback
 * connection pending while its local-network permission prompt is on screen, and a person answers slowly.
 */
export const CONNECT_TIMEOUT_MS = 120_000;
/** How long a bridge has to send a valid `hello` once the socket is open. */
export const HELLO_TIMEOUT_MS = 5_000;
/** How long a bridge has to answer `pair` with `paired`. */
export const PAIRED_TIMEOUT_MS = 10_000;

/** Close reasons that mean the sign-in itself is over, so what the assistant did is no longer the new person's to read. */
const AUTH_ENDING_REASONS: ReadonlySet<TabCloseReason> = new Set(['sign-out', 'user-switch']);

const NORMAL_CLOSE = 1000;
const utf8 = new TextEncoder();

const DEFAULT_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SessionOptions {
  /** `null` when the build carries no bridge port: nothing dials. */
  port: number | null;
  openSocket: SocketFactory;
  /** `unlockResolved`, `isUnlocked` and a household, read at call time. */
  isWorkspaceReady: () => boolean;
  appBuildId: string;
  /** Moves the tab's idle clock; called once per completed call, and only while the consent has the D7 switch on. */
  noteActivity: () => void;
  /** The consent step. The default agrees at once with the default consent (switch off). */
  requestConsent?: () => Promise<SessionConsent | 'declined'>;
  timers?: Timers;
  now?: () => number;
  /** State names only; never a code, a nonce or a payload. */
  log?: (message: string) => void;
}

export type ConnectResult = 'started' | 'unavailable' | 'busy' | 'malformed-code';

export interface SessionSnapshot {
  phase: SessionPhase;
  /** How the last session ended; `null` before the first one and while a new one runs. */
  end: SessionEnd | null;
  consent: SessionConsent;
  audit: readonly AuditEntry[];
}

interface HandshakeState {
  bridgeNonce: string;
  tabNonce: string;
  pairSent: boolean;
  verifying: boolean;
}

export class AssistantSession {
  private phase: SessionPhase = 'idle';
  private socket: SocketLike | null = null;
  /** The normalized pairing code; held for the handshake only. */
  private code: string | null = null;
  private handshake: HandshakeState | null = null;
  private lastEnd: SessionEnd | null = null;
  private consent: SessionConsent = DEFAULT_CONSENT;
  /** Bumped whenever a session ends, so an await that outlives its session knows to stop. */
  private epoch = 0;
  private deadline: unknown = null;
  private readonly audit = new AuditLog();
  private readonly dispatcher: CallDispatcher;
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private snapshot: SessionSnapshot;

  constructor(private readonly options: SessionOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.now = options.now ?? Date.now;
    this.dispatcher = new CallDispatcher({
      registry: TOOL_REGISTRY,
      timers: this.timers,
      now: this.now,
      isWorkspaceReady: options.isWorkspaceReady,
      appBuildId: options.appBuildId,
      send: (frame) => this.sendFrame(frame),
      onSettled: (call) => this.onSettled(call),
    });
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Registers the handler for a registry tool; the tool rows call this. */
  registerHandler(name: string, handler: ToolHandler): () => void {
    return this.dispatcher.register(name, handler);
  }

  /** Starts a pairing. The code is normalized here and never leaves this object except as a proof. */
  connect(rawCode: string): ConnectResult {
    if (this.options.port === null) return 'unavailable';
    if (this.phase !== 'idle') return 'busy';
    const code = normalizePairingCode(rawCode);
    if (code === null) return 'malformed-code';
    this.audit.clear();
    this.lastEnd = null;
    this.code = code;
    this.epoch += 1;
    this.setPhase('connecting');
    let socket: SocketLike;
    try {
      socket = this.options.openSocket(bridgeSocketUrl(this.options.port));
    } catch {
      this.finish({ phase: 'connecting', close: { kind: 'failed-to-open' } });
      return 'started';
    }
    this.socket = socket;
    this.armDeadline(CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.setPhase('awaiting-hello');
      this.armDeadline(HELLO_TIMEOUT_MS);
      this.notify();
    });
    socket.addEventListener('message', (event) => {
      if (socket === this.socket) this.onMessage(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (socket === this.socket) this.finish({ phase: this.phase, close: { kind: 'remote', code: event.code } });
    });
    this.notify();
    return 'started';
  }

  disconnect(): void {
    this.end('disconnect');
  }

  /** Ends the session, closing the socket normally with `reason`. Safe to call in any phase. */
  end(reason: TabCloseReason): void {
    const hadEntries = this.audit.entries().length > 0;
    if (AUTH_ENDING_REASONS.has(reason)) this.audit.clear();
    if (this.phase === 'idle') {
      if (hadEntries && this.audit.entries().length === 0) this.notify();
      return;
    }
    this.finish({ phase: this.phase, close: { kind: 'tab', reason } }, NORMAL_CLOSE, reason);
  }

  private setPhase(next: SessionPhase): void {
    this.phase = next;
    this.options.log?.(`phase ${next}`);
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private buildSnapshot(): SessionSnapshot {
    return { phase: this.phase, end: this.lastEnd, consent: this.consent, audit: this.audit.entries() };
  }

  private armDeadline(ms: number): void {
    this.clearDeadline();
    const epoch = this.epoch;
    this.deadline = this.timers.set(() => {
      if (epoch !== this.epoch) return;
      this.finish({ phase: this.phase, close: { kind: 'deadline' } }, CLOSE_CODES.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
    }, ms);
  }

  private clearDeadline(): void {
    if (this.deadline !== null) this.timers.clear(this.deadline);
    this.deadline = null;
  }

  /** Ends the session. `closeCode` is given when the tab closes the socket; a close the peer made needs none. */
  private finish(end: SessionEnd, closeCode?: number, closeReason?: string): void {
    if (this.phase === 'idle') return;
    const socket = this.socket;
    this.epoch += 1;
    this.clearDeadline();
    this.socket = null;
    this.code = null;
    this.handshake = null;
    this.consent = DEFAULT_CONSENT;
    this.dispatcher.abortAll();
    this.lastEnd = end;
    this.setPhase('idle');
    this.options.log?.(`ended in ${end.phase}: ${describeClose(end)}`);
    if (socket !== null && closeCode !== undefined) {
      try {
        socket.close(closeCode, closeReason);
      } catch {
        // Already closing; nothing left to release.
      }
    }
    this.notify();
  }

  private failProtocol(error: HandshakeErrorCode): void {
    this.finish({ phase: this.phase, close: { kind: 'local', error } }, CLOSE_CODES[error], error);
  }

  private sendFrame(frame: TabFrame): void {
    if (this.socket === null) return;
    const encoded = encodeFrame(frame);
    if (!encoded.ok) {
      this.failProtocol(encoded.code);
      return;
    }
    try {
      this.socket.send(encoded.text);
    } catch {
      // The socket is going away; its close event ends the session.
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') {
      this.failProtocol('PROTOCOL_ERROR');
      return;
    }
    const decoded = decodeFrame('bridge', data);
    if (!decoded.ok) {
      this.failProtocol(decoded.code);
      return;
    }
    const frame = decoded.frame;
    if (this.phase === 'awaiting-hello' && frame.type === 'hello') {
      this.onHello(frame.protocolVersion, frame.bridgeNonce);
    } else if (this.phase === 'awaiting-paired' && frame.type === 'paired' && this.handshake?.pairSent === true && !this.handshake.verifying) {
      void this.onPaired(frame.bridgeProof);
    } else if (this.phase === 'ready' && frame.type === 'call') {
      if (!this.dispatcher.handleCall(frame)) this.failProtocol('PROTOCOL_ERROR');
    } else if (this.phase === 'ready' && frame.type === 'cancel') {
      this.dispatcher.handleCancel(frame.id);
    } else {
      this.failProtocol('PROTOCOL_ERROR');
    }
  }

  private onHello(protocolVersion: number, bridgeNonce: string): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.failProtocol('PROTOCOL_VERSION_MISMATCH');
      return;
    }
    const code = this.code;
    if (code === null) return;
    const epoch = this.epoch;
    const handshake: HandshakeState = { bridgeNonce, tabNonce: generateNonce(), pairSent: false, verifying: false };
    this.handshake = handshake;
    this.setPhase('awaiting-paired');
    this.armDeadline(PAIRED_TIMEOUT_MS);
    this.notify();
    computeTabProof({ code, bridgeNonce, tabNonce: handshake.tabNonce }).then(
      (tabProof) => {
        if (epoch !== this.epoch) return;
        handshake.pairSent = true;
        this.sendFrame({ type: 'pair', protocolVersion: PROTOCOL_VERSION, tabNonce: handshake.tabNonce, tabProof });
      },
      () => {
        if (epoch === this.epoch) this.failProtocol('PROTOCOL_ERROR');
      },
    );
  }

  private async onPaired(bridgeProof: string): Promise<void> {
    const code = this.code;
    const handshake = this.handshake;
    if (code === null || handshake === null) return;
    const epoch = this.epoch;
    handshake.verifying = true;
    let expected: string;
    try {
      expected = await computeBridgeProof({ code, bridgeNonce: handshake.bridgeNonce, tabNonce: handshake.tabNonce });
    } catch {
      if (epoch === this.epoch) this.failProtocol('PROTOCOL_ERROR');
      return;
    }
    if (epoch !== this.epoch) return;
    if (!constantTimeEqual(utf8.encode(expected), utf8.encode(bridgeProof))) {
      this.failProtocol('PAIRING_FAILED');
      return;
    }
    // The bridge proved itself: the code and both nonces have done their job.
    this.code = null;
    this.handshake = null;
    this.clearDeadline();
    this.setPhase('paired');
    this.setPhase('awaiting-consent');
    this.notify();
    let answer: SessionConsent | 'declined';
    try {
      answer = await (this.options.requestConsent ?? agreeWithDefaults)();
    } catch {
      answer = 'declined';
    }
    if (epoch !== this.epoch) return;
    if (answer === 'declined') {
      this.end('consent-declined');
      return;
    }
    this.consent = answer;
    this.setPhase('ready');
    this.sendFrame({ type: 'ready', keepSignedInWhileActive: answer.keepSignedInWhileActive });
    this.notify();
  }

  private onSettled(call: SettledCall): void {
    const movesIdleClock = call.completed && this.phase === 'ready' && this.consent.keepSignedInWhileActive;
    if (movesIdleClock) this.options.noteActivity();
    this.audit.record({
      at: this.now(),
      tool: call.tool,
      argsSummary: call.argsSummary,
      outcome: call.outcome,
      durationMs: call.durationMs,
      bytes: call.bytes,
      movedIdleClock: movesIdleClock,
      payload: call.payload,
    });
    this.notify();
  }
}

async function agreeWithDefaults(): Promise<SessionConsent> {
  return DEFAULT_CONSENT;
}

function describeClose(end: SessionEnd): string {
  const { close } = end;
  switch (close.kind) {
    case 'tab':
      return `tab closed (${close.reason})`;
    case 'local':
      return `tab closed (${close.error})`;
    case 'remote':
      return `socket closed (${close.code})`;
    default:
      return close.kind;
  }
}
