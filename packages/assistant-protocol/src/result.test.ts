import { describe, expect, it } from 'vitest';
import { PAIRING_ENTRY_PATH } from './constants.js';
import { formatPairingCode } from './pairing.js';
import {
  failureResult,
  notPairedAwaitingCode,
  notPairedAwaitingConsent,
  toolNotSupported,
  toolResultSchema,
} from './result.js';

const origin = 'https://app.example.com';
const pairingCode = formatPairingCode('7QW49KXMZ2');
const expiresAt = '2026-01-01T00:05:00.000Z';

describe('tool result envelope', () => {
  it('carries the code, expiry and entry URL while awaiting the code', () => {
    const result = toolResultSchema.parse(notPairedAwaitingCode({ origin, pairingCode, expiresAt }));
    if (result.ok || result.error.code !== 'NOT_PAIRED' || result.error.state !== 'awaiting-code') throw new Error('wrong shape');
    expect(result.error.pairingCode).toBe('7QW49-KXMZ2');
    expect(result.error.expiresAt).toBe(expiresAt);
    expect(result.error.enterAt).toBe(`${origin}${PAIRING_ENTRY_PATH}`);
    expect(result.error.instructions).toContain(result.error.pairingCode);
    expect(result.error.instructions).toContain(result.error.enterAt);
  });

  it('rejects a malformed pairing code', () => {
    const built = notPairedAwaitingCode({ origin, pairingCode: '7QW49KXMZ2', expiresAt });
    expect(toolResultSchema.safeParse(built).success).toBe(false);
  });

  it('never carries a code once awaiting consent', () => {
    const leaky = { ...notPairedAwaitingConsent(), error: { ...(notPairedAwaitingConsent() as { error: object }).error, pairingCode } };
    const parsed = toolResultSchema.parse(leaky);
    expect(JSON.stringify(parsed)).not.toContain(pairingCode);
    expect(JSON.stringify(notPairedAwaitingConsent())).not.toMatch(/pairingCode|expiresAt|enterAt/);
  });

  it('requires the state on NOT_PAIRED', () => {
    expect(toolResultSchema.safeParse({ ok: false, error: { code: 'NOT_PAIRED', message: 'x' } }).success).toBe(false);
  });

  it('names the tool and the app build when unsupported', () => {
    const result = toolResultSchema.parse(toolNotSupported('retivo_status', 'build-7'));
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_SUPPORTED', tool: 'retivo_status', appBuildId: 'build-7' } });
  });

  it('rejects an ok result without a disclosure', () => {
    expect(toolResultSchema.safeParse({ ok: true, payload: {} }).success).toBe(false);
    expect(toolResultSchema.safeParse({ ok: true, payload: {}, disclosure: {} }).success).toBe(true);
  });

  it('accepts a plain failure', () => {
    expect(toolResultSchema.parse(failureResult('WORKSPACE_LOCKED', 'Locked.'))).toEqual({
      ok: false,
      error: { code: 'WORKSPACE_LOCKED', message: 'Locked.' },
    });
  });
});
