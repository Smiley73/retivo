/** The copyable command that starts the bridge in Claude Code or Codex. */
import { DEFAULT_BRIDGE_PORT } from './constants.js';

/**
 * The bridge is one file the app serves from its own origin (build_spa puts it in the SPA's `dist/`
 * beside `bridge.json`, which names the file's SHA-256, size and version). A person downloads it once
 * and the agent runs it with `node`.
 */
export const BRIDGE_FILE = 'retivo-mcp-bridge.mjs';
/** The license and copyright notices of everything embedded in the bridge file, served beside it. */
export const BRIDGE_NOTICES_FILE = 'retivo-mcp-bridge-notices.txt';
/** `{ version, sha256, size }` of the served bridge file. */
export const BRIDGE_MANIFEST_FILE = 'bridge.json';

// Where the person saves the file. `$HOME` is left for the shell to expand, so the path the agent
// stores is absolute: the agent starts the bridge from another folder.
const BRIDGE_DIR = '"$HOME/.retivo"';
const BRIDGE_PATH = `"$HOME/.retivo/${BRIDGE_FILE}"`;
const BRIDGE_DOWNLOAD_PATH = `"$HOME/.retivo/${BRIDGE_FILE}.download"`;
/** What the agent runs to start the saved bridge. */
export const BRIDGE_LAUNCHER = `node ${BRIDGE_PATH}`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
  return [agent, 'mcp', 'add', 'retivo', '--', BRIDGE_LAUNCHER, ...flags].join(' ');
}

/**
 * One line the person pastes before adding the bridge: it downloads the file from `origin`, checks it
 * against `sha256` (the value in the app's own `bridge.json`) and only then moves it into place, so a
 * file that does not match is never left where the agent would run it. Throws on an origin or
 * checksum that is unsafe to paste into a shell.
 */
export function bridgeInstallCommand(options: { origin: string; sha256: string }): string {
  assertSafeOrigin(options.origin);
  if (!SHA256_PATTERN.test(options.sha256)) throw new Error('The checksum must be 64 lowercase hex digits');
  return [
    `mkdir -p ${BRIDGE_DIR}`,
    `curl -fsSL ${options.origin}/${BRIDGE_FILE} -o ${BRIDGE_DOWNLOAD_PATH}`,
    `echo "${options.sha256}  $HOME/.retivo/${BRIDGE_FILE}.download" | shasum -a 256 -c -`,
    `mv ${BRIDGE_DOWNLOAD_PATH} ${BRIDGE_PATH}`,
  ].join(' && ');
}
