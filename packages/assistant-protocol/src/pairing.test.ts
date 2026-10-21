import { describe, expect, it } from 'vitest';
import { NONCE_BYTES } from './constants.js';
import {
  computeBridgeProof,
  computeTabProof,
  constantTimeEqual,
  formatPairingCode,
  generateNonce,
  isWellFormedPairingCode,
  normalizePairingCode,
} from './pairing.js';

// Frozen vector: any change to the derivation, tags or encoding must fail here.
const VECTOR = {
  code: '7QW49KXMZ2',
  bridgeNonce: Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
  tabNonce: Array.from({ length: 32 }, (_, i) => (i + 32).toString(16).padStart(2, '0')).join(''),
  tabProof: '34e2fc9033a8225366d782444e5de29aaedf89b5d3912c1f3a2c93c0151148b6',
  bridgeProof: 'e7bea19670af3423ef90743b33da8ab92e031b7673f5dd6cea883d4728f5b216',
};

describe('pairing proofs', () => {
  it('matches the frozen vector', async () => {
    expect(await computeTabProof(VECTOR)).toBe(VECTOR.tabProof);
    expect(await computeBridgeProof(VECTOR)).toBe(VECTOR.bridgeProof);
  });

  it('accepts the display form and typing variants of the same code', async () => {
    expect(await computeTabProof({ ...VECTOR, code: '7qw49-kxmz2' })).toBe(VECTOR.tabProof);
  });

  it('gives the tab and the bridge different proofs for the same inputs', async () => {
    expect(await computeTabProof(VECTOR)).not.toBe(await computeBridgeProof(VECTOR));
  });

  it('changes both proofs when either nonce or one code character changes', async () => {
    const variants = [
      { ...VECTOR, bridgeNonce: 'ff'.repeat(32) },
      { ...VECTOR, tabNonce: 'ff'.repeat(32) },
      { ...VECTOR, code: '7QW49KXMZ3' },
    ];
    for (const variant of variants) {
      expect(await computeTabProof(variant)).not.toBe(VECTOR.tabProof);
      expect(await computeBridgeProof(variant)).not.toBe(VECTOR.bridgeProof);
    }
  });

  it('refuses a malformed code or nonce', async () => {
    await expect(computeTabProof({ ...VECTOR, code: 'short' })).rejects.toThrow();
    await expect(computeBridgeProof({ ...VECTOR, bridgeNonce: 'zz' })).rejects.toThrow();
  });

  it('generates distinct hex nonces of the right size', () => {
    const a = generateNonce();
    expect(a).toMatch(new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`));
    expect(generateNonce()).not.toBe(a);
  });
});

describe('pairing code rules', () => {
  it('maps look-alikes, case, hyphens and spaces to the canonical form', () => {
    expect(normalizePairingCode('ilo1l0o1l0')).toBe('1101100110');
    expect(normalizePairingCode('7qw49-kxmz2')).toBe('7QW49KXMZ2');
    expect(normalizePairingCode(' 7QW49 KXMZ2 ')).toBe('7QW49KXMZ2');
  });

  it('rejects a wrong length or a character outside the alphabet', () => {
    expect(normalizePairingCode('7QW49KXMZ')).toBeNull();
    expect(normalizePairingCode('7QW49KXMZ22')).toBeNull();
    expect(normalizePairingCode('7QW49KXMZU')).toBeNull();
    expect(normalizePairingCode('7QW49KXMZ!')).toBeNull();
    expect(isWellFormedPairingCode('7QW49KXMZ2')).toBe(true);
    expect(isWellFormedPairingCode('nope')).toBe(false);
  });

  it('formats and normalizes as inverses', () => {
    expect(formatPairingCode('7QW49KXMZ2')).toBe('7QW49-KXMZ2');
    expect(normalizePairingCode(formatPairingCode('7QW49KXMZ2'))).toBe('7QW49KXMZ2');
    expect(() => formatPairingCode('bad')).toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical bytes', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});
