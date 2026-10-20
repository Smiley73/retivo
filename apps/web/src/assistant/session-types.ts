/** Types shared by the session state machine, the diagnosis and the provider. */
import type { HandshakeErrorCode, TabCloseReason } from '@retirement/assistant-protocol';

/**
 * Where a session is. `paired` (the bridge proved itself) and
 * `awaiting-consent` (the person has yet to agree) are separate on purpose:
 * this row passes through the second at once with the default consent, and the
 * consent step fills it.
 */
export type SessionPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting-hello'
  | 'awaiting-paired'
  | 'paired'
  | 'awaiting-consent'
  | 'ready';

/** How a session ended, kept in memory until the next one begins. */
export type CloseInfo =
  /** The tab closed the socket on purpose. */
  | { kind: 'tab'; reason: TabCloseReason }
  /** The tab closed the socket because of what it received: a frame, a version or a proof. */
  | { kind: 'local'; error: HandshakeErrorCode }
  /** The socket closed under the tab, with the close code the browser reported. */
  | { kind: 'remote'; code: number }
  /** No valid `hello` (or no `paired`) arrived before the deadline. */
  | { kind: 'deadline' }
  /** The browser refused to build the socket at all. */
  | { kind: 'failed-to-open' };

export interface SessionEnd {
  /** The phase the session was in when it ended. */
  phase: SessionPhase;
  close: CloseInfo;
}

/** What the person agreed to share and keep alive; row 5 fills the real step. */
export interface SessionConsent {
  /** The D7 switch: completed calls count as activity. Off unless the consent step says otherwise. */
  keepSignedInWhileActive: boolean;
}

export const DEFAULT_CONSENT: SessionConsent = { keepSignedInWhileActive: false };

/** The slice of a `WebSocket` the session drives; the browser's, `ws` and Node's global one all fit. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

/** Builds the socket for a URL. Injected so unit tests script it and bridge tests use a real one. */
export type SocketFactory = (url: string) => SocketLike;
