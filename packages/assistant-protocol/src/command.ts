/** The copyable command that starts the bridge in Claude Code, Codex or Cursor. */
import { DEFAULT_BRIDGE_PORT } from './constants.js';

/** What the agent runs to start the bridge (a provisional value until the distribution path is decided). */
export const DEFAULT_BRIDGE_LAUNCHER = 'npx -y retivo-mcp-bridge';

export type AgentName = 'claude' | 'codex' | 'cursor';

// The result is pasted into a shell, so the origin is held to a narrow
// character set on top of being a bare origin.
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function assertSafeOrigin(origin: string): void {
  const valid = ORIGIN_PATTERN.test(origin) && URL.canParse(origin);
  const url = valid ? new URL(origin) : null;
  const allowed = url !== null && (url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname));
  if (!allowed || url.origin !== origin) {
    throw new Error('Origin must be a bare https:// origin or a loopback http:// origin');
  }
}

function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw new Error('Port must be an integer from 1025 to 65535');
}

/**
 * One line the person pastes: `claude mcp add` / `codex mcp add` for the CLIs, a
 * one-line `mcp.json` server object for Cursor. Throws on an origin or port that
 * is unsafe to paste into a shell.
 */
export function bridgeCommandFor(agent: AgentName, options: { origin: string; port?: number }): string {
  assertSafeOrigin(options.origin);
  const port = options.port ?? DEFAULT_BRIDGE_PORT;
  assertSafePort(port);
  const flags = ['--origin', options.origin, ...(port === DEFAULT_BRIDGE_PORT ? [] : ['--port', String(port)])];
  if (agent === 'cursor') {
    const [command, ...args] = DEFAULT_BRIDGE_LAUNCHER.split(' ');
    return JSON.stringify({ mcpServers: { retivo: { command, args: [...args, ...flags] } } });
  }
  return [agent, 'mcp', 'add', 'retivo', '--', DEFAULT_BRIDGE_LAUNCHER, ...flags].join(' ');
}
