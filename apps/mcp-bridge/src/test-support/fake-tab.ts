/** A scripted stand-in for the signed-in Retivo tab: a real `ws` client plus the protocol's own proof functions. */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { computeBridgeProof, computeTabProof, generateNonce, PROTOCOL_VERSION } from '@retirement/assistant-protocol';

export const TEST_ORIGIN = 'https://app.example.com';

export type Frame = Record<string, unknown> & { type: string };

export interface TabOptions {
  origin?: string | null;
  headers?: Record<string, string>;
  /** `false` stops the client answering pings, as a tab that vanished would. */
  autoPong?: boolean;
}

export class FakeTab {
  readonly frames: Frame[] = [];
  /** Every frame ever received, counting those already consumed by `next`. */
  received = 0;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: ((frame: Frame) => void)[] = [];
  private constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.received += 1;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.frames.push(frame);
      else waiter(frame);
    });
    socket.on('error', () => undefined);
  }

  /** Resolves once the upgrade is accepted; rejects with the HTTP status when it is refused. */
  static connect(port: number, options: TabOptions = {}): Promise<FakeTab> {
    return new Promise((resolve, reject) => {
      const headers = { ...options.headers };
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        ...(options.origin !== null && { origin: options.origin ?? TEST_ORIGIN }),
        headers,
        autoPong: options.autoPong ?? true,
      });
      socket.once('open', () => resolve(new FakeTab(socket)));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        reject(new Error(`status ${response.statusCode}`));
      });
      socket.once('error', (error) => reject(error));
    });
  }

  /** The next frame, whether it already arrived or not. */
  next(timeoutMs = 2000): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  send(frame: object | string): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** `hello`, `pair` with a proof for `code`, then the bridge's `paired` (its proof checked). Returns the frames. */
  async pair(code: string, overrides: { protocolVersion?: number; proof?: string } = {}): Promise<{ hello: Frame; paired: Frame }> {
    const hello = await this.next();
    const tabNonce = generateNonce();
    const bridgeNonce = hello.bridgeNonce as string;
    const tabProof = overrides.proof ?? (await computeTabProof({ code, bridgeNonce, tabNonce }));
    this.send({ type: 'pair', protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION, tabNonce, tabProof });
    // The bridge may refuse the pair by closing instead of answering.
    const paired = await Promise.race([this.next(), this.closed.then((): Frame => ({ type: 'closed' }))]);
    if (paired.type === 'paired') {
      const expected = await computeBridgeProof({ code, bridgeNonce, tabNonce });
      if (paired.bridgeProof !== expected) throw new Error('bridge proof did not verify');
    }
    return { hello, paired };
  }

  /** Pairs, then sends `ready`. */
  async connectFully(code: string): Promise<void> {
    await this.pair(code);
    this.send({ type: 'ready' });
  }

  close(code = 1000): void {
    this.socket.close(code);
  }
}

/** A unique marker for the log-leak test. */
export function sentinel(label: string): string {
  return `SENTINEL-${label}-${randomBytes(6).toString('hex')}`;
}
