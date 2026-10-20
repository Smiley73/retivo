/** The copyable command that starts the bridge in Claude Code or Codex. */
import { DEFAULT_BRIDGE_PORT } from './constants.js';

/** What the agent runs to start the bridge (a provisional value until the distribution path is decided). */
export const DEFAULT_BRIDGE_LAUNCHER = 'npx -y retivo-mcp-bridge';

export type AgentName = 'claude' | 'codex';

// The result is pasted into a shell, so the origin is held to a narrow
// character set on top of being a bare origin.
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Throws unless `origin` is a bare https:// origin or a loopback http:// origin; shared with the bridge's `--origin`. */
export function assertSafeOrigin(origin: string): void {
  const valid = ORIGIN_PATTERN.test(origin) && URL.canParse(origin);
  const url = valid ? new URL(origin) : null;
  const allowed = url !== null && (url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname));
  if (!allowed || url.origin !== origin) {
    throw new Error('Origin must be a bare https:// origin or a loopback http:// origin');
  }
}

/** Throws unless `port` is an integer from 1025 to 65535; shared with the bridge's `--port`. */
export function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw new Error('Port must be an integer from 1025 to 65535');
}

/**
 * One line the person pastes: `claude mcp add` / `codex mcp add`. Throws on an origin or port that
 * is unsafe to paste into a shell.
 */
export function bridgeCommandFor(agent: AgentName, options: { origin: string; port?: number }): string {
  assertSafeOrigin(options.origin);
  const port = options.port ?? DEFAULT_BRIDGE_PORT;
  assertSafePort(port);
  const flags = ['--origin', options.origin, ...(port === DEFAULT_BRIDGE_PORT ? [] : ['--port', String(port)])];
  return [agent, 'mcp', 'add', 'retivo', '--', DEFAULT_BRIDGE_LAUNCHER, ...flags].join(' ');
}
