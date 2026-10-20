#!/usr/bin/env node
// Entry point only (excluded from coverage: the subprocess test is what runs
// it). stdout is the MCP transport, so nothing here may write to it: all
// diagnostics go through the stderr logger and the lines below.
import { readFileSync } from 'node:fs';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { USAGE, parseBridgeArgs } from './args.js';
import { startBridge, type Bridge } from './bridge.js';
import { createLogger } from './logger.js';

const parsed = parseBridgeArgs(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n${USAGE}`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const logger = createLogger();

let bridge: Bridge;
try {
  bridge = await startBridge({ origin: parsed.origin, port: parsed.port, bridgeVersion: version, logger });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(
    code === 'EADDRINUSE'
      ? `Port ${parsed.port} is already in use; another Retivo bridge is probably running.\n`
      : `The bridge could not start: ${code ?? 'unknown error'}.\n`,
  );
  process.exit(1);
}

const transport = new StdioServerTransport();
const mcp = serveStdio(() => bridge.createMcpServer(), {
  transport,
  onerror: (error) => logger.log({ event: 'mcp_error', name: error.name }),
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // A hung close must not keep the process alive after the agent is gone.
  setTimeout(() => process.exit(0), 2000).unref();
  await Promise.allSettled([mcp.close(), bridge.close()]);
  process.exitCode = 0;
}

// The transport closes itself when stdout breaks (EPIPE) or its input fails, and then pauses stdin, so
// no EOF follows: its closure is the signal that the agent is gone. serveStdio owns `onclose`, so chain it.
const closeConnection = transport.onclose;
transport.onclose = () => {
  closeConnection?.();
  void stop();
};
// stdin EOF: the agent is gone, so the tab's socket closes normally and we exit 0.
process.stdin.once('end', () => void stop());
process.stdin.once('close', () => void stop());
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
