/** Protocol-wide constants shared by the bridge and the tab: version, port, caps and pairing material. */

/**
 * Wire protocol version, an integer compared for equality in the handshake.
 * Additions inside one version are optional fields; a breaking change bumps
 * this and the tab tells the person to update the bridge.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Default loopback port the bridge listens on. Above 1024, below every OS
 * ephemeral range (Linux starts at 32768, macOS and Windows at 49152), and not
 * in the IANA service-name registry.
 */
export const DEFAULT_BRIDGE_PORT = 24580;

/** The WebSocket URL the tab dials; the CSP `connect-src` entry is this exact string. */
export function loopbackWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

/** Largest serialized frame in bytes (UTF-8, not string length), checked by `encodeFrame` and `decodeFrame`. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Largest serialized tool result in bytes; leaves room under `MAX_FRAME_BYTES` for the frame envelope. */
export const MAX_TOOL_RESULT_BYTES = MAX_FRAME_BYTES - 16 * 1024;

/** Timeout a plain read tool declares. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Shortest timeout a registry entry may declare. */
export const MIN_CALL_TIMEOUT_MS = 1_000;
/** Longest timeout a registry entry may declare (long-running compute tools). */
export const MAX_CALL_TIMEOUT_MS = 10 * 60_000;

/** Longest text one static prompt message may carry; a prompt is read into the agent's context on every use. */
export const MAX_PROMPT_TEXT_CHARS = 4_000;

/** Calls the bridge relays at once before answering `TOO_MANY_IN_FLIGHT`. */
export const MAX_IN_FLIGHT_CALLS = 2;
/** Calls per minute the bridge relays before answering `RATE_LIMITED`. */
export const MAX_CALLS_PER_MINUTE = 60;

/** Random bytes in each handshake nonce. */
export const NONCE_BYTES = 32;

/** Crockford base32: digits and letters without I, L, O and U. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Characters in a pairing code (about 50 bits). */
export const PAIRING_CODE_LENGTH = 10;
/** How long a pairing code stays valid. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** Wrong guesses allowed before the code is dead. */
export const PAIRING_MAX_ATTEMPTS = 3;

/** In-app route where the person types the pairing code; the `NOT_PAIRED` instructions point here. */
export const PAIRING_ENTRY_PATH = '/profile';
