import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  HANDSHAKE_ERROR_CODES,
  TAB_CLOSE_REASONS,
  errorCodeSchema,
  handshakeErrorForCloseCode,
} from './codes.js';
import {
  DEFAULT_BRIDGE_PORT,
  MAX_FRAME_BYTES,
  MAX_TOOL_RESULT_BYTES,
  loopbackWsUrl,
} from './constants.js';

describe('codes and constants', () => {
  it('gives every handshake error a unique close code in 4000-4999', () => {
    const codes = HANDSHAKE_ERROR_CODES.map((code) => CLOSE_CODES[code]);
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('maps close codes back, including the ws payload-limit close', () => {
    expect(handshakeErrorForCloseCode(CLOSE_CODES.PAIRING_FAILED)).toBe('PAIRING_FAILED');
    expect(handshakeErrorForCloseCode(1009)).toBe('FRAME_TOO_LARGE');
    expect(handshakeErrorForCloseCode(1000)).toBeUndefined();
  });

  it('lists every error code once', () => {
    expect(errorCodeSchema.options).toHaveLength(new Set(errorCodeSchema.options).size);
  });

  it('keeps tab close reasons short ASCII', () => {
    for (const reason of TAB_CLOSE_REASONS) {
      expect(reason).toMatch(/^[\x20-\x7e]+$/);
      expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123);
    }
  });

  it('keeps the default port clear of privileged and ephemeral ranges', () => {
    expect(DEFAULT_BRIDGE_PORT).toBeGreaterThan(1024);
    expect(DEFAULT_BRIDGE_PORT).toBeLessThan(32768);
  });

  it('leaves room for the frame envelope under the frame cap', () => {
    expect(MAX_FRAME_BYTES - MAX_TOOL_RESULT_BYTES).toBeGreaterThanOrEqual(4 * 1024);
  });

  it('builds the loopback URL with no trailing slash', () => {
    expect(loopbackWsUrl(24580)).toBe('ws://127.0.0.1:24580');
  });
});
