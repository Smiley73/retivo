import { describe, expect, it, vi } from 'vitest';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  normalizePairingCode,
} from '@retirement/assistant-protocol';
import { PairingCodeStore } from './pairing-code-store.js';
import { Clock } from './test-support/clock.js';

describe('PairingCodeStore', () => {
  it('mints nothing until asked and then mints a well-formed code', () => {
    const store = new PairingCodeStore();
    expect(store.peek()).toBeNull();
    const { code } = store.activeOrMint();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(normalizePairingCode(code)).toBe(code);
  });

  it('reuses the code while it is valid, so a second call cannot invalidate what the person is typing', () => {
    const store = new PairingCodeStore();
    const first = store.activeOrMint();
    expect(store.activeOrMint()).toEqual(first);
  });

  it('mints a different code after expiry', () => {
    const clock = new Clock();
    const store = new PairingCodeStore({ now: clock.now });
    const first = store.activeOrMint();
    expect(first.expiresAtMs).toBe(clock.now() + PAIRING_CODE_TTL_MS);
    clock.advance(PAIRING_CODE_TTL_MS - 1);
    expect(store.peek()?.code).toBe(first.code);
    clock.advance(1);
    expect(store.peek()).toBeNull();
    expect(store.activeOrMint().code).not.toBe(first.code);
  });

  it('counts wrong proofs across connections and kills the code when attempts run out', () => {
    const store = new PairingCodeStore();
    const { code } = store.activeOrMint();
    for (let i = 1; i < PAIRING_MAX_ATTEMPTS; i += 1) expect(store.recordFailure(code)).toBe('retry');
    expect(store.recordFailure(code)).toBe('exhausted');
    expect(store.peek()).toBeNull();
    expect(store.activeOrMint().code).not.toBe(code);
  });

  it('treats a failure against a code that is gone as exhausted and leaves the live code alone', () => {
    const store = new PairingCodeStore();
    const { code } = store.activeOrMint();
    expect(store.recordFailure('0000000000')).toBe('exhausted');
    expect(store.peek()?.code).toBe(code);
  });

  it('is single use once consumed', () => {
    const store = new PairingCodeStore();
    const { code } = store.activeOrMint();
    store.consume('0000000000');
    expect(store.peek()?.code).toBe(code);
    store.consume(code);
    expect(store.peek()).toBeNull();
    expect(store.activeOrMint().code).not.toBe(code);
  });

  it('draws each character through an unbiased integer over the whole alphabet and never Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const randomIndex = vi.fn((max: number) => max - 1);
    const { code } = new PairingCodeStore({ randomIndex }).activeOrMint();
    expect(randomIndex).toHaveBeenCalledTimes(PAIRING_CODE_LENGTH);
    expect(randomIndex).toHaveBeenCalledWith(PAIRING_CODE_ALPHABET.length);
    expect(code).toBe('Z'.repeat(PAIRING_CODE_LENGTH));
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('uses every alphabet character with the default CSPRNG', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const store = new PairingCodeStore();
      for (const char of store.activeOrMint().code) seen.add(char);
    }
    expect([...seen].sort().join('')).toBe(PAIRING_CODE_ALPHABET);
  });
});
