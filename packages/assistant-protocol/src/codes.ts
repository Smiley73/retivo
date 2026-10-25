/** Error codes, WebSocket close codes and the tab's close reasons. */
import { z } from 'zod';

/** Codes a tool result can carry. */
const TOOL_ERROR_CODES = [
  'NOT_PAIRED',
  'TOOL_NOT_SUPPORTED',
  'WORKSPACE_LOCKED',
  'UNKNOWN_TOOL',
  'INVALID_ARGS',
  'CALL_TIMEOUT',
  'CANCELLED',
  'TOO_MANY_IN_FLIGHT',
  'RATE_LIMITED',
  'OUTPUT_TOO_LARGE',
  'COMPUTE_CAP_EXCEEDED',
  'INTERNAL',
] as const;

/** Codes that end the socket; each has a close code in `CLOSE_CODES`. */
const HANDSHAKE_ERROR_CODES = [
  'PROTOCOL_VERSION_MISMATCH',
  'PAIRING_FAILED',
  'PAIRING_ATTEMPTS_EXCEEDED',
  'PAIRING_EXPIRED',
  'ALREADY_CONNECTED',
  'FRAME_TOO_LARGE',
  'PROTOCOL_ERROR',
] as const;

export const errorCodeSchema = z.enum([...TOOL_ERROR_CODES, ...HANDSHAKE_ERROR_CODES]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type HandshakeErrorCode = (typeof HANDSHAKE_ERROR_CODES)[number];

/** WebSocket close code (4000-4999, the application range) per handshake-level error. */
export const CLOSE_CODES: Record<HandshakeErrorCode, number> = {
  PROTOCOL_VERSION_MISMATCH: 4001,
  PAIRING_FAILED: 4002,
  PAIRING_ATTEMPTS_EXCEEDED: 4003,
  PAIRING_EXPIRED: 4004,
  ALREADY_CONNECTED: 4005,
  FRAME_TOO_LARGE: 4006,
  PROTOCOL_ERROR: 4007,
};

/** The close code `ws` raises on its own when `maxPayload` is exceeded. */
const WS_MESSAGE_TOO_BIG = 1009;

/** Maps a received close code back to its handshake error, or `undefined` for a normal or unknown close. */
export function handshakeErrorForCloseCode(closeCode: number): HandshakeErrorCode | undefined {
  if (closeCode === WS_MESSAGE_TOO_BIG) return 'FRAME_TOO_LARGE';
  return HANDSHAKE_ERROR_CODES.find((code) => CLOSE_CODES[code] === closeCode);
}

/** Reason strings for the tab's normal close (limited to 123 bytes by the WebSocket spec). */
export type TabCloseReason = 'disconnect' | 'sign-out' | 'idle' | 'lock' | 'user-switch' | 'pagehide' | 'consent-declined';
