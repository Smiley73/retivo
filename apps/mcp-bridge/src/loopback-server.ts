/**
 * The loopback WebSocket server the signed-in tab dials. The upgrade is the
 * security boundary: `Origin` and `Host` are compared as exact strings before
 * anything is sent, and a request that fails gets a 403 and a destroyed socket,
 * never a `hello`. One tab holds the single slot; a second socket is accepted
 * only to be closed with `ALREADY_CONNECTED`, because a browser cannot read why
 * an upgrade was refused and would report "bridge absent".
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_CODES, MAX_FRAME_BYTES } from '@retirement/assistant-protocol';
import type { Logger } from './logger.js';
import type { PairingCodeStore } from './pairing-code-store.js';
import type { Relay } from './relay.js';
import { Session, type ClientInfo } from './session.js';

const LOOPBACK_HOST = '127.0.0.1';

export interface LoopbackServerOptions {
  origin: string;
  /** 0 picks a free port (tests); the bound port is on the returned server. */
  port: number;
  relay: Relay;
  codes: PairingCodeStore;
  logger: Logger;
  bridgeVersion: string;
  getClient: () => ClientInfo | undefined;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface LoopbackServer {
  /** The address the server actually bound, from `server.address()`. */
  host: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;

/** How many times a header appears; a duplicated `Origin` or `Host` is refused, not resolved. */
function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) count += 1;
  }
  return count;
}

/** Answers 403 and destroys the socket once the response is flushed. */
function refuse(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
}

/** Binds `127.0.0.1:<port>` explicitly; rejects with the listen error (`EADDRINUSE` included). */
export function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const { logger } = options;
  const http: Server = createServer((_request, response) => {
    response.writeHead(426, { 'Content-Length': 0, Connection: 'close' }).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sockets = new Set<WebSocket>();
  let slotTaken = false;
  let expectedHost = '';

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own socket error handler before emitting 'upgrade': a peer reset during the 403 would throw.
    socket.on('error', () => undefined);
    const origin = request.headers.origin;
    const refusal =
      request.method !== 'GET'
        ? 'method'
        : headerCount(request, 'origin') > 1 || headerCount(request, 'host') > 1
          ? 'duplicate_header'
          : origin !== options.origin
            ? 'origin'
            : request.headers.host !== expectedHost
              ? 'host'
              : null;
    if (refusal !== null) {
      logger.log({ event: 'upgrade_rejected', reason: refusal, ...(origin !== undefined && { origin }) });
      refuse(socket);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws));
  });

  function accept(ws: WebSocket): void {
    // 'error' always precedes a 'close' that carries the code; it needs a listener so it cannot throw,
    // on a socket rejected for a taken slot as much as on the session's own.
    ws.on('error', () => undefined);
    if (slotTaken) {
      logger.log({ event: 'socket_rejected', closeCode: CLOSE_CODES.ALREADY_CONNECTED });
      ws.close(CLOSE_CODES.ALREADY_CONNECTED);
      return;
    }
    slotTaken = true;
    sockets.add(ws);
    let alive = true;
    // A tab that vanishes without a close frame never fires 'close' on its own:
    // the missed pong is what ends the session.
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    const session = new Session({
      socket: ws,
      relay: options.relay,
      codes: options.codes,
      logger,
      bridgeVersion: options.bridgeVersion,
      getClient: options.getClient,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      onEnd: () => {
        slotTaken = false;
        clearInterval(pinger);
      },
    });
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data, isBinary) => session.handleMessage(data, isBinary));
    ws.on('close', (code) => {
      sockets.delete(ws);
      session.handleClose(code);
    });
  }

  return new Promise((resolve, rejectListen) => {
    http.once('error', rejectListen);
    http.listen({ host: LOOPBACK_HOST, port: options.port }, () => {
      http.off('error', rejectListen);
      const { port, address } = http.address() as AddressInfo;
      expectedHost = `${LOOPBACK_HOST}:${port}`;
      logger.log({ event: 'listening', port, origin: options.origin });
      resolve({
        host: address,
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.close(1000);
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
