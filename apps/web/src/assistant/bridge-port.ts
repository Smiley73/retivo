/**
 * The loopback port of the local AI assistant bridge, baked into the SPA at
 * build time (`VITE_ASSISTANT_BRIDGE_PORT`, written by `build_spa` from the
 * `retivo:assistantBridgePort` stack key). Unset or blank means the connector
 * is off: every other module in `assistant/` treats `null` as "inert" and
 * never builds a socket URL.
 *
 * A value outside the integer range 1024-65535 is a build mistake worth one
 * console warning, never a throw: the app must still boot, and the connector
 * stays off (the `parseBetaFeatureConfig` stance). The deploy's own contract
 * test is what fails loudly on a bad stack value.
 *
 * The socket URL is built here too, behind a build-time check, so a production
 * build without the variable carries no loopback URL at all: the bundler drops
 * the template with the dead branch (pinned by
 * `scripts/test/assistant-bridge-bundle-contract.test.mjs`).
 */
import { loopbackWsUrl } from '@retirement/assistant-protocol';

const MIN_PORT = 1024;
const MAX_PORT = 65535;

const warned = new Set<string>();

export function readBridgePort(): number | null {
  const raw = (import.meta.env.VITE_ASSISTANT_BRIDGE_PORT as string | undefined)?.trim();
  if (raw === undefined || raw === '') return null;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) return port;
  if (!warned.has(raw)) {
    warned.add(raw);
    console.warn(
      `[assistant] VITE_ASSISTANT_BRIDGE_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}; the AI assistant connector stays off.`,
    );
  }
  return null;
}

/**
 * The WebSocket URL for the bridge on `port`. In a production build that
 * carries no `VITE_ASSISTANT_BRIDGE_PORT` the condition is a compile-time
 * constant, the call below is dead code, and the URL template never reaches the
 * bundle. No caller can reach this branch there: `readBridgePort()` is `null`
 * without the variable, and the session never dials without a port.
 */
export function bridgeSocketUrl(port: number): string {
  if (import.meta.env.PROD && import.meta.env.VITE_ASSISTANT_BRIDGE_PORT === undefined) {
    throw new Error('This build carries no AI assistant bridge port.');
  }
  return loopbackWsUrl(port);
}
