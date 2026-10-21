/** Wires the pairing store, relay and loopback server together; the bin and the tests both start it here. */
import type { McpServer } from '@modelcontextprotocol/server';
import { assertSafeOrigin, assertSafePort } from '@retirement/assistant-protocol';
import type { Logger } from './logger.js';
import { startLoopbackServer, type LoopbackServer } from './loopback-server.js';
import { createMcpServer, type McpServerDeps } from './mcp-server.js';
import { PairingCodeStore, type PairingCodeStoreOptions } from './pairing-code-store.js';
import { Relay } from './relay.js';
import type { ClientInfo } from './session.js';

export interface BridgeOptions {
  origin: string;
  /** 0 picks a free port; only tests use it. */
  port: number;
  bridgeVersion: string;
  logger: Logger;
  /** Test seams. */
  now?: () => number;
  codes?: PairingCodeStoreOptions;
  tools?: McpServerDeps['tools'];
  prompts?: McpServerDeps['prompts'];
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface Bridge {
  /** The bound address, always `127.0.0.1`. */
  host: string;
  port: number;
  /** One MCP server per MCP connection; stdio has exactly one. */
  createMcpServer(): McpServer;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  assertSafeOrigin(options.origin);
  if (options.port !== 0) assertSafePort(options.port);
  const now = options.now ?? Date.now;
  const codes = new PairingCodeStore({ now, ...options.codes });
  const relay = new Relay({ origin: options.origin, codes, logger: options.logger, now });
  let current: McpServer | undefined;
  const getClient = (): ClientInfo | undefined => {
    const client = current?.server.getClientVersion();
    return client === undefined ? undefined : { name: client.name, version: client.version };
  };
  const loopback: LoopbackServer = await startLoopbackServer({
    origin: options.origin,
    port: options.port,
    relay,
    codes,
    logger: options.logger,
    bridgeVersion: options.bridgeVersion,
    getClient,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    pingIntervalMs: options.pingIntervalMs,
  });
  return {
    host: loopback.host,
    port: loopback.port,
    createMcpServer() {
      current = createMcpServer({ relay, bridgeVersion: options.bridgeVersion, tools: options.tools, prompts: options.prompts });
      return current;
    },
    close: () => loopback.close(),
  };
}
