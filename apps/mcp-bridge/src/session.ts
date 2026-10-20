/**
 * One tab connection's state machine. The protocol fixes the frame order
 * (`hello`, `pair`, `paired`, `ready`, then calls); this owns the states in
 * between: a version check before any proof, proofs compared in constant time,
 * and an end that is idempotent whichever side closes first, so the single tab
 * slot is free the moment the session is decided over.
 */
import type { RawData } from 'ws';
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  computeBridgeProof,
  computeTabProof,
  constantTimeEqual,
  decodeFrame,
  encodeFrame,
  generateNonce,
  type BridgeFrame,
  type HandshakeErrorCode,
  type TabFrame,
} from '@retirement/assistant-protocol';
import type { Logger } from './logger.js';
import type { PairingCodeStore } from './pairing-code-store.js';
import type { Relay } from './relay.js';

/** The slice of a `ws` socket a session drives. */
interface SessionSocket {
  send(text: string, callback?: (error?: Error | null) => void): void;
  close(code: number): void;
}

export interface ClientInfo {
  name: string;
  version: string;
}

export interface SessionOptions {
  socket: SessionSocket;
  relay: Relay;
  codes: PairingCodeStore;
  logger: Logger;
  bridgeVersion: string;
  /** What the MCP `initialize` handshake learned; absent until a client has initialized. */
  getClient: () => ClientInfo | undefined;
  /** Window to receive a valid `pair` after `hello` before an idle socket gives up the slot. */
  handshakeTimeoutMs: number;
  /** Called once when the session is over, so the server can free the tab slot. */
  onEnd: () => void;
}

type State = 'awaiting-pair' | 'verifying' | 'awaiting-ready' | 'ready' | 'ended';

const utf8 = new TextEncoder();

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export class Session {
  private state: State = 'awaiting-pair';
  private readonly bridgeNonce = generateNonce();
  private readonly handshakeTimer: NodeJS.Timeout;
  private relayEngaged = false;

  constructor(private readonly options: SessionOptions) {
    this.handshakeTimer = setTimeout(() => this.fail('PROTOCOL_ERROR'), options.handshakeTimeoutMs);
    options.logger.log({ event: 'session_started' });
    const client = options.getClient();
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      bridgeNonce: this.bridgeNonce,
      bridgeVersion: options.bridgeVersion.slice(0, 64),
      ...(client !== undefined && { client: { name: client.name.slice(0, 128), version: client.version.slice(0, 64) } }),
    });
  }

  /** A message from the tab. */
  handleMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'ended') return;
    if (isBinary) {
      this.fail('PROTOCOL_ERROR');
      return;
    }
    const decoded = decodeFrame('tab', toText(data));
    if (!decoded.ok) {
      this.fail(decoded.code);
      return;
    }
    const frame = decoded.frame;
    if (this.state === 'awaiting-pair' && frame.type === 'pair') {
      this.verifyPair(frame).catch(() => this.fail('PROTOCOL_ERROR'));
    } else if (this.state === 'awaiting-ready' && frame.type === 'ready') {
      this.state = 'ready';
      this.options.relay.activate({ sendText: (text) => this.sendText(text) });
      this.options.logger.log({ event: 'session_ready' });
    } else if (this.state === 'ready' && frame.type === 'progress') {
      this.options.relay.handleProgress(frame);
    } else if (this.state === 'ready' && frame.type === 'result') {
      this.options.relay.handleResult(frame);
    } else {
      this.fail('PROTOCOL_ERROR');
    }
  }

  /** The socket closed or errored: whichever side ended it, the session is over. */
  handleClose(closeCode?: number): void {
    this.end(closeCode);
  }

  private async verifyPair(frame: Extract<TabFrame, { type: 'pair' }>): Promise<void> {
    this.state = 'verifying';
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      this.fail('PROTOCOL_VERSION_MISMATCH');
      return;
    }
    const active = this.options.codes.peek();
    if (active === null) {
      this.fail('PAIRING_EXPIRED');
      return;
    }
    const proofInputs = { code: active.code, bridgeNonce: this.bridgeNonce, tabNonce: frame.tabNonce };
    const expected = await computeTabProof(proofInputs);
    if (this.isEnded()) return;
    if (this.options.codes.peek()?.code !== active.code) {
      this.fail('PAIRING_EXPIRED');
      return;
    }
    if (!constantTimeEqual(utf8.encode(expected), utf8.encode(frame.tabProof))) {
      this.fail(this.options.codes.recordFailure(active.code) === 'exhausted' ? 'PAIRING_ATTEMPTS_EXCEEDED' : 'PAIRING_FAILED');
      return;
    }
    const bridgeProof = await computeBridgeProof(proofInputs);
    if (this.isEnded()) return;
    this.options.codes.consume(active.code);
    this.state = 'awaiting-ready';
    this.relayEngaged = true;
    this.options.relay.beginConsent();
    clearTimeout(this.handshakeTimer);
    this.send({ type: 'paired', bridgeProof });
    this.options.logger.log({ event: 'session_paired' });
  }

  private isEnded(): boolean {
    return this.state === 'ended';
  }

  private send(frame: BridgeFrame): void {
    const encoded = encodeFrame(frame);
    if (!encoded.ok) {
      this.fail(encoded.code);
      return;
    }
    this.sendText(encoded.text);
  }

  private sendText(text: string): void {
    if (this.state === 'ended') throw new Error('Session has ended');
    this.options.socket.send(text, (error) => {
      if (error) this.end();
    });
  }

  /** Ends the session and closes the socket with the close code of a handshake-level error. */
  private fail(code: HandshakeErrorCode): void {
    if (this.state === 'ended') return;
    const closeCode = CLOSE_CODES[code];
    this.end(closeCode, code);
    this.options.socket.close(closeCode);
  }

  private end(closeCode?: number, handshakeError?: HandshakeErrorCode): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    clearTimeout(this.handshakeTimer);
    if (this.relayEngaged) this.options.relay.endSession();
    this.options.logger.log({
      event: 'session_ended',
      ...(closeCode !== undefined && { closeCode }),
      ...(handshakeError !== undefined && { handshakeError }),
    });
    this.options.onEnd();
  }
}
