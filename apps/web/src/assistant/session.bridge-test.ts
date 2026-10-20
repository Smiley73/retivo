/**
 * The tab's session against the real, built MCP bridge (`apps/mcp-bridge`),
 * the only interop proof of the wire encoding: the pairing proofs, the frame
 * order and the close codes are checked end to end, with a real WebSocket on
 * one side and a real stdio MCP client on the other.
 *
 * Run with `pnpm --filter @retirement/web test:bridge` after building the
 * protocol package and the bridge. The MCP side is a few hand-written
 * JSON-RPC lines; no SDK enters the web workspace.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@retirement/assistant-protocol';
import { diagnose } from './diagnosis';
import { AssistantSession } from './session';
import type { SocketLike } from './session-types';

const BIN = fileURLToPath(new URL('../../../mcp-bridge/dist/bin.js', import.meta.url));
/** The origin the harness plays; the bridge compares it with the tab's `Origin` header as an exact string. */
const ORIGIN = 'http://localhost:5199';

interface RpcMessage {
  id?: number;
  result?: { content: { text: string }[]; structuredContent?: ToolResult; isError?: boolean };
  error?: { message: string };
}

interface Bridge {
  port: number;
  /** Calls an MCP tool over stdio and returns its structured result. */
  callTool(name: string): Promise<{ result: ToolResult; isError: boolean }>;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startBridge(): Promise<Bridge> {
  expect(existsSync(BIN), 'apps/mcp-bridge/dist/bin.js is missing: build the protocol package and the bridge first').toBe(true);
  const port = await freePort();
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN, '--origin', ORIGIN, '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (message: RpcMessage) => void>();
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const write = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object): Promise<RpcMessage> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  await waitFor(() => stderr.includes('"event":"listening"'), 'the bridge to listen');
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'web-bridge-test', version: '0.0.0' } });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    port,
    async callTool(name) {
      const message = await request('tools/call', { name, arguments: {} });
      if (message.result === undefined) throw new Error(`tools/call ${name}: ${message.error?.message ?? 'no result'}`);
      return { result: message.result.structuredContent as ToolResult, isError: message.result.isError === true };
    },
    stop() {
      child.kill('SIGKILL');
    },
  };
}

/** Node's own WebSocket, with the `Origin` header a browser would add itself. */
function openSocketFor(): (url: string) => SocketLike {
  return (url) => new WebSocket(url, { headers: { Origin: ORIGIN } } as unknown as string);
}

function newSession(port: number): AssistantSession {
  return new AssistantSession({
    port,
    openSocket: openSocketFor(),
    isWorkspaceReady: () => true,
    appBuildId: 'bridge-test',
    noteActivity: () => undefined,
  });
}

function pairingCodeOf(result: ToolResult): string {
  if (result.ok || result.error.code !== 'NOT_PAIRED' || result.error.state !== 'awaiting-code') {
    throw new Error('expected NOT_PAIRED while awaiting the code');
  }
  return result.error.pairingCode;
}

let bridge: Bridge;
let port: number;
const sessions: AssistantSession[] = [];

beforeEach(async () => {
  bridge = await startBridge();
  port = bridge.port;
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.disconnect();
  bridge.stop();
});

/** Reads a fresh code from the bridge, as the person's assistant would show it. */
async function freshCode(): Promise<string> {
  return pairingCodeOf((await bridge.callTool('retivo_status')).result);
}

function track(session: AssistantSession): AssistantSession {
  sessions.push(session);
  return session;
}

describe('the tab against the real bridge', () => {
  it('pairs, answers a stub tool, reports an unsupported one, refuses a second tab and a reused code', async () => {
    const code = await freshCode();
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    const session = track(newSession(port));
    session.registerHandler('retivo_status', () => ({ ok: true, payload: { stub: true }, disclosure: {} }));
    expect(session.connect(code)).toBe('started');
    await waitFor(() => session.getSnapshot().phase === 'ready', 'the session to be ready');

    // The stub tool is answered, and audited.
    const answered = await bridge.callTool('retivo_status');
    expect(answered).toEqual({ isError: false, result: { ok: true, payload: { stub: true }, disclosure: {} } });
    const [entry] = session.getSnapshot().audit;
    expect(entry).toMatchObject({ tool: 'retivo_status', outcome: 'ok', movedIdleClock: false });
    expect(JSON.parse(entry!.payload!)).toEqual(answered.result);

    // A registry name with no handler reaches the MCP client as TOOL_NOT_SUPPORTED.
    const unsupported = await bridge.callTool('retivo_list_scenarios');
    expect(unsupported.isError).toBe(true);
    expect(unsupported.result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_SUPPORTED', tool: 'retivo_list_scenarios', appBuildId: 'bridge-test' } });

    // A second tab is accepted only to be told it is a second tab.
    const second = track(newSession(port));
    second.connect('0123456789');
    await waitFor(() => second.getSnapshot().phase === 'idle', 'the second socket to be refused');
    const { end } = second.getSnapshot();
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'already-connected' });
    expect(session.getSnapshot().phase).toBe('ready');

    // After Disconnect the same code is dead: the bridge asks for a new one.
    session.disconnect();
    expect(session.getSnapshot().end?.close).toEqual({ kind: 'tab', reason: 'disconnect' });
    expect(session.getSnapshot().audit).toHaveLength(2);
    let after = await bridge.callTool('retivo_status');
    for (let attempt = 0; attempt < 100 && !(!after.result.ok && after.result.error.code === 'NOT_PAIRED'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await bridge.callTool('retivo_status');
    }
    const reused = track(newSession(port));
    reused.connect(code);
    await waitFor(() => reused.getSnapshot().phase === 'idle', 'the reused code to be refused');
    const refused = reused.getSnapshot().end!;
    expect(refused.close.kind).toBe('remote');
    expect(['wrong-code', 'code-expired']).toContain(diagnose(refused.phase, refused.close, 'unknown').kind);
  });

  it('ends three wrong codes with PAIRING_ATTEMPTS_EXCEEDED', async () => {
    await freshCode();
    const kinds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = track(newSession(port));
      session.connect('0123456789');
      await waitFor(() => session.getSnapshot().phase === 'idle' && session.getSnapshot().end !== null, `attempt ${attempt + 1} to be refused`);
      const { end } = session.getSnapshot();
      kinds.push(diagnose(end!.phase, end!.close, 'unknown').kind);
    }
    expect(kinds).toEqual(['wrong-code', 'wrong-code', 'attempts-exceeded']);
  });

  it('refuses a dial when the port is unset, without touching the network', async () => {
    const session = new AssistantSession({
      port: null,
      openSocket: () => {
        throw new Error('must not dial');
      },
      isWorkspaceReady: () => true,
      appBuildId: 'bridge-test',
      noteActivity: () => undefined,
    });
    expect(session.connect('0123456789')).toBe('unavailable');
  });
});
