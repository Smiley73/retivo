/**
 * Process lifecycle: spawns the built bin (`pnpm test` builds `dist/` first) with
 * a real stdio MCP session and a real `ws` tab. This is the only test that
 * catches a stray write to stdout in the bin wiring.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, toMcpToolDeclaration } from '@retirement/assistant-protocol';
import { FakeTab, TEST_ORIGIN, sentinel } from './test-support/fake-tab.js';
import { McpTestClient, type RpcMessage } from './test-support/mcp-test-client.js';
import { startHarness, type Harness } from './test-support/harness.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

interface Run {
  child: ChildProcessWithoutNullStreams;
  client: McpTestClient;
  stdoutLines: string[];
  stderr: () => string;
  exit: Promise<number | null>;
}

const children: ChildProcessWithoutNullStreams[] = [];
let harness: Harness | undefined;
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await harness?.close();
  harness = undefined;
});

function run(args: string[]): Run {
  expect(existsSync(BIN), 'dist/bin.js is missing: run the bridge build (pnpm test does)').toBe(true);
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const stdoutLines: string[] = [];
  let stderr = '';
  const client = new McpTestClient((message) => child.stdin.write(`${JSON.stringify(message)}\n`));
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      stdoutLines.push(line);
      client.receive(JSON.parse(line) as RpcMessage);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, client, stdoutLines, stderr: () => stderr, exit };
}

/** A free port, found by binding 0 and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** `ready` has no acknowledgement on the wire; the bridge's own log line is the signal. */
async function waitForStderr(stderr: () => string, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!stderr().includes(text)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${text} on stderr`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectWhenListening(port: number): Promise<FakeTab> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await FakeTab.connect(port);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe('the built bin', () => {
  it('lists the registry at start, answers NOT_PAIRED, pairs, relays a call and exits 0 with a normal close on stdin EOF', async () => {
    const port = await freePort();
    const { child, client, stdoutLines, stderr, exit } = run(['--origin', TEST_ORIGIN, '--port', String(port)]);
    await client.initialize({ name: 'bin-test', version: '1.0.0' });
    const { tools } = (await client.request('tools/list')) as { tools: unknown[] };
    expect(tools).toEqual(TOOL_REGISTRY.map(toMcpToolDeclaration));

    const notPaired = await client.callTool('retivo_status');
    expect(notPaired.isError).toBeUndefined();
    const code = (notPaired.structuredContent as { error: { pairingCode: string } }).error.pairingCode;

    const tab = await connectWhenListening(port);
    const { hello } = await tab.pair(code);
    expect(hello.client).toEqual({ name: 'bin-test', version: '1.0.0' });
    tab.send({ type: 'ready' });

    const agentSentinel = sentinel('ARGS');
    const tabSentinel = sentinel('RESULT');
    await waitForStderr(stderr, 'session_ready');
    const call = client.callToolRaw('retivo_get_plan_data', { note: agentSentinel });
    const frame = await tab.next();
    tab.send({ type: 'result', id: frame.id, result: { ok: true, payload: { note: tabSentinel }, disclosure: {} } });
    const relayed = { frame, text: JSON.stringify((await call.response).result) };
    expect(relayed.frame).toMatchObject({ type: 'call', tool: 'retivo_get_plan_data', args: { note: agentSentinel } });
    expect(relayed.text).toContain(tabSentinel);

    child.stdin.end();
    expect(await exit).toBe(0);
    expect(await tab.closed).toMatchObject({ code: 1000 });

    for (const line of stdoutLines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    const logs = stderr();
    expect(logs).toContain('session_ended');
    expect(logs).not.toContain(agentSentinel);
    expect(logs).not.toContain(tabSentinel);
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(code.replace('-', ''));
  });

  it('prints usage and exits 2 on bad arguments', async () => {
    const { stderr, exit } = run(['--origin', 'http://evil.example.com']);
    expect(await exit).toBe(2);
    expect(stderr()).toContain('Usage: retivo-mcp-bridge');
  });

  it('exits non-zero naming the port when another bridge holds it, and the first keeps serving', async () => {
    harness = await startHarness();
    const { stderr, exit } = run(['--origin', TEST_ORIGIN, '--port', String(harness.port)]);
    expect(await exit).toBe(1);
    expect(stderr()).toContain(String(harness.port));
    expect(stderr()).toContain('another');
    const tab = await harness.newTab();
    expect((await tab.next()).type).toBe('hello');
  });

  it('exits 0 on stdin EOF before any tab connected', async () => {
    const port = await freePort();
    const { child, client, exit } = run(['--origin', TEST_ORIGIN, '--port', String(port)]);
    await client.initialize();
    child.stdin.end();
    expect(await exit).toBe(0);
  });
});
