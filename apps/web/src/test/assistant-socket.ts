/**
 * Test double for the assistant tab's socket, plus a scripted bridge that
 * speaks the handshake with the protocol package's own proof functions. The
 * double records every frame the session sends and lets a test play the
 * bridge's frames and close events; a scripted pass cannot catch an encoding
 * disagreement with the real bridge (the `*.bridge-test.ts` suite does).
 */
import { PROTOCOL_VERSION, computeBridgeProof, generateNonce } from '@retirement/assistant-protocol';
import type { SocketLike } from '../assistant/session-types';

// Captured before any test installs fake timers, so waiting stays real.
const realSetImmediate = globalThis.setImmediate;

/** Waits (in real macrotasks) until `condition` holds; WebCrypto resolves off the microtask queue. */
export async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Listener = (event: never) => void;

export class ScriptedSocket implements SocketLike {
  readyState = 0;
  /** Every text frame the session sent, in order. */
  readonly sent: string[] = [];
  closeCall: { code?: number; reason?: string } | null = null;
  private readonly listeners: Record<string, Listener[]> = {};

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCall = { code, reason };
    this.readyState = 3;
  }

  get frames(): Array<Record<string, unknown> & { type: string }> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown> & { type: string });
  }

  /** The session sent at least `count` frames. */
  sentAtLeast(count: number): boolean {
    return this.sent.length >= count;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', undefined);
  }

  /** The bridge sends a frame (an object is JSON-encoded) or raw text. */
  receive(frame: object | string): void {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  emitClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code });
  }

  emitError(): void {
    this.emit('error', undefined);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) (listener as (event: unknown) => void)(event);
  }
}

export function bridgeHello(overrides: { protocolVersion?: number; bridgeNonce?: string } = {}): object {
  return {
    type: 'hello',
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    bridgeNonce: overrides.bridgeNonce ?? generateNonce(),
    bridgeVersion: '0.0.0-test',
  };
}

/**
 * Plays a correct bridge up to `ready`: opens the socket, sends `hello`, waits
 * for the tab's `pair`, answers with a valid proof for `code`, and waits for
 * `ready`. Resolves with the nonces it used.
 */
export async function pairScripted(socket: ScriptedSocket, code: string): Promise<{ bridgeNonce: string; tabNonce: string }> {
  socket.open();
  const bridgeNonce = generateNonce();
  socket.receive(bridgeHello({ bridgeNonce }));
  await until(() => socket.sentAtLeast(1), 'the pair frame');
  const tabNonce = socket.frames[0]!.tabNonce as string;
  socket.receive({ type: 'paired', bridgeProof: await computeBridgeProof({ code, bridgeNonce, tabNonce }) });
  await until(() => socket.sentAtLeast(2), 'the ready frame');
  return { bridgeNonce, tabNonce };
}
