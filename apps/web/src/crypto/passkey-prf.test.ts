/**
 * Unit tests for WebAuthn PRF-extension plumbing.
 *
 * Covers the two required behaviors: a PRF result present in the assertion
 * yields a usable wrap key (PRF slot path), and an absent/unsupported PRF
 * result fails soft (returns null) so the caller falls back to password.
 */
import { describe, it, expect } from 'vitest';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import {
  addPrfEvalToOptions,
  derivePrfWrapKey,
  extractPrfResult,
  generatePrfSalt,
} from './passkey-prf';
import { base64UrlToBytes } from './payload-crypto';

function assertionWith(clientExtensionResults: Record<string, unknown>): AuthenticationResponseJSON {
  return {
    id: 'cred-1',
    rawId: 'cred-1',
    response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c' },
    clientExtensionResults: clientExtensionResults as never,
    type: 'public-key',
  };
}

describe('passkey-prf — option plumbing', () => {
  it('adds a PRF eval request for the slot salt without mutating the input', () => {
    const salt = generatePrfSalt();
    const options = { challenge: 'chal', extensions: { appid: 'x' } } as never;
    const next = addPrfEvalToOptions(options, salt);
    const ext = next.extensions as unknown as { appid?: string; prf?: { eval: { first: Uint8Array } } };
    expect(ext.appid).toBe('x'); // server-provided extensions preserved
    expect(ext.prf?.eval.first).toBeInstanceOf(Uint8Array);
    // Original options object is untouched (no `prf` key leaked back in).
    expect((options as { extensions: { prf?: unknown } }).extensions.prf).toBeUndefined();
  });
});

describe('passkey-prf — result extraction (PRF success path)', () => {
  it('extracts the PRF result bytes from an ArrayBuffer result', () => {
    const bytes = base64UrlToBytes(generatePrfSalt());
    const response = assertionWith({ prf: { results: { first: bytes.buffer } } });
    const result = extractPrfResult(response);
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual(Array.from(bytes));
  });

  it('derives a usable AES-GCM wrap key from a PRF result', async () => {
    const response = assertionWith({
      prf: { results: { first: base64UrlToBytes(generatePrfSalt()).buffer } },
    });
    const result = extractPrfResult(response);
    const wrapKey = await derivePrfWrapKey(result!);
    expect(wrapKey).toBeInstanceOf(CryptoKey);
    expect(wrapKey.algorithm.name).toBe('AES-GCM');
  });
});

describe('passkey-prf — graceful fallback (PRF unsupported/failure)', () => {
  it('returns null when the authenticator returned no PRF result', () => {
    expect(extractPrfResult(assertionWith({}))).toBeNull();
  });

  it('returns null when the prf extension has no results', () => {
    expect(extractPrfResult(assertionWith({ prf: {} }))).toBeNull();
  });
});
