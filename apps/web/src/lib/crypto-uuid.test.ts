import { afterEach, describe, expect, it, vi } from 'vitest';

import { cryptoUuid } from './crypto-uuid';

const realCrypto = globalThis.crypto;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function filling(byte: number) {
  return (array: Uint8Array) => {
    array.fill(byte);
    return array;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cryptoUuid', () => {
  it('returns exactly what crypto.randomUUID returns when it exists', () => {
    const sentinel = '00000000-0000-4000-8000-00000000abcd';
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID: () => sentinel, getRandomValues });
    expect(cryptoUuid()).toBe(sentinel);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  describe('with only getRandomValues', () => {
    it('forces version and variant bits over all-0xff bytes', () => {
      vi.stubGlobal('crypto', { getRandomValues: filling(0xff) });
      const id = cryptoUuid();
      expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
      expect(id).toMatch(UUID_V4);
    });

    it('forces version and variant bits over all-0x00 bytes', () => {
      vi.stubGlobal('crypto', { getRandomValues: filling(0x00) });
      const id = cryptoUuid();
      expect(id).toBe('00000000-0000-4000-8000-000000000000');
      expect(id).toMatch(UUID_V4);
    });

    it('produces canonical lowercase v4 UUIDs that differ between calls', () => {
      vi.stubGlobal('crypto', {
        getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      });
      const ids = Array.from({ length: 50 }, () => cryptoUuid());
      for (const id of ids) {
        expect(id).toHaveLength(36);
        expect(id).toMatch(UUID_V4);
      }
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('with no secure random source', () => {
    it('throws when crypto is undefined', () => {
      vi.stubGlobal('crypto', undefined);
      expect(() => cryptoUuid()).toThrow(/secure random source/);
    });

    it('throws the helper error when crypto is an empty object', () => {
      vi.stubGlobal('crypto', {});
      expect(() => cryptoUuid()).toThrow(/secure random source/);
    });
  });
});
