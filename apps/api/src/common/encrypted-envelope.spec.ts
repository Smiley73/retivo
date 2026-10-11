/**
 * Unit tests for the server-side strict encrypted-envelope detector.
 * Mirrors the web client's `isStrictEncryptedEnvelope`
 * cases so the two guards agree on the wire shape.
 */
import { isStrictEncryptedEnvelope } from './encrypted-envelope.js';

function validEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2U',
    ciphertext: 'Y2lwaGVy',
    ...overrides,
  };
}

describe('isStrictEncryptedEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope())).toBe(true);
  });

  it('accepts the optional numeric aadVersion', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ aadVersion: 2 }))).toBe(true);
  });

  it('rejects null / non-object', () => {
    expect(isStrictEncryptedEnvelope(null)).toBe(false);
    expect(isStrictEncryptedEnvelope('x')).toBe(false);
    expect(isStrictEncryptedEnvelope(7)).toBe(false);
  });

  it('rejects a plaintext domain payload that merely carries encryptionVersion', () => {
    expect(isStrictEncryptedEnvelope({ encryptionVersion: 1, name: 'Account' })).toBe(
      false,
    );
  });

  it('rejects a wrong encryptionVersion or alg', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ encryptionVersion: 2 }))).toBe(false);
    expect(isStrictEncryptedEnvelope(validEnvelope({ alg: 'AES-128-GCM' }))).toBe(false);
  });

  it('rejects missing / non-string nonce, ciphertext, keyId', () => {
    const noNonce = validEnvelope();
    delete noNonce.nonce;
    expect(isStrictEncryptedEnvelope(noNonce)).toBe(false);
    const noCipher = validEnvelope();
    delete noCipher.ciphertext;
    expect(isStrictEncryptedEnvelope(noCipher)).toBe(false);
    expect(isStrictEncryptedEnvelope(validEnvelope({ keyId: 5 }))).toBe(false);
  });

  it('rejects a non-number aadVersion', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ aadVersion: 'x' }))).toBe(false);
  });

  // An otherwise-valid
  // envelope carrying one extra key is refused at the zero-knowledge
  // boundary, not stored/served alongside real ciphertext.
  it('rejects an otherwise-valid envelope carrying one extra key', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ name: 'plaintext-leak' }))).toBe(
      false,
    );
  });

  it('still accepts every documented key, including the optional aadVersion', () => {
    expect(isStrictEncryptedEnvelope(validEnvelope({ aadVersion: 2 }))).toBe(true);
  });
});
